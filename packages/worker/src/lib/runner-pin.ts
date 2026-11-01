/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies the
 * fetched runner files' sha256 BEFORE the box token is materialized — a tampered
 * or unpinned runner never sees credentials and the box fails closed (never
 * heartbeats; the provision-grace reaper path reclaims it).
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Repo-relative path -> sha256 hex at that ref. Always contains RUNNER_ENTRY. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9._-]{1,64}$/
const SHA256_RE = /^[0-9a-f]{64}$/
// Paths are interpolated into a root shell script and joined onto the install
// dir: no traversal, no hidden segments, nothing that needs quoting.
const SAFE_PATH_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/

/** The validated manifest with paths sorted, or null when it is malformed. */
export function parseRunnerFiles(files: unknown): Record<string, string> | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return null
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return null
	const entries = Object.entries(files)
	const valid = entries.every(
		([path, sha256]) =>
			SAFE_PATH_RE.test(path) && typeof sha256 === 'string' && SHA256_RE.test(sha256),
	)
	if (!valid) return null
	return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)))
}

/**
 * Normalize fleet:config into a pin. A config without `runner_files` is a
 * legacy single-file pin. A `runner_files` that is present but invalid never
 * falls back to `runner_sha256`: that would boot without the manifest's checks.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	const { runner_ref: ref, runner_sha256: sha256, runner_files: runnerFiles } = config
	if (typeof ref !== 'string' || !REF_RE.test(ref)) return null
	const files =
		runnerFiles === undefined || runnerFiles === null
			? parseRunnerFiles({ [RUNNER_ENTRY]: sha256 })
			: parseRunnerFiles(runnerFiles)
	return files ? { ref, files } : null
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch all → verify all → install all. Aborts non-zero on any
 * missing or mismatched file (callers run under `set -euo pipefail`), and
 * because nothing moves until every hash passed, it leaves nothing installed.
 * No fallback to a baked copy — fail closed is the point.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	const files = parseRunnerFiles(pin.files)
	if (!REF_RE.test(pin.ref) || !files) throw new Error('invalid runner pin manifest')
	const paths = Object.keys(files)
	const destDir = opts.destDir ?? '/opt/fermi'
	// Sibling of destDir: same filesystem for mv, and a refused boot leaves
	// destDir itself untouched.
	const stage = `${destDir}.new`
	const urlFor = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl}/${path}` : runnerUrl(pin.ref, path)
	const subdirs = new Set(
		paths.filter((p) => p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/'))),
	)
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	return [
		`rm -rf '${stage}'`,
		...paths.map(
			(path) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors --create-dirs '${urlFor(path)}' -o '${stage}/${path}'`,
		),
		...paths.map((path) => `echo '${files[path]}  ${stage}/${path}' | sha256sum -c - >/dev/null`),
		...[...subdirs].map((dir) => `mkdir -p '${destDir}/${dir}'`),
		...paths.map((path) => `mv -f '${stage}/${path}' '${destDir}/${path}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
