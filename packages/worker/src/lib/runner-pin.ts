/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file never sees credentials and the box fails closed
 * (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * import the daemon's shared modules (`harness/`, `lib/`). A legacy
 * single-file pin (`runner_ref` + `runner_sha256`) is the manifest
 * `{ 'box-runner.mjs': sha256 }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'
const MAX_FILES = 64

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Repo-relative path → sha256 hex at that ref. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_RE = /^[0-9a-f]{64}$/
// Each segment starts with an alphanumeric or `_`: no `.`/`..`, no absolute
// paths, no hidden files, nothing a shell single-quote could break out of.
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

export function isSafeRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

export function isSafeRunnerPath(path: unknown): path is string {
	return (
		typeof path === 'string' &&
		path.length > 0 &&
		path.length <= 200 &&
		path.split('/').every((s) => SEGMENT_RE.test(s))
	)
}

export function isSha256(v: unknown): v is string {
	return typeof v === 'string' && SHA256_RE.test(v)
}

/** Validate a `{ path: sha256 }` manifest; returns null when anything is off. */
export function parseRunnerFiles(files: unknown): Record<string, string> | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return null
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_FILES) return null
	const out: Record<string, string> = {}
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path) || !isSha256(sha)) return null
		out[path] = sha
	}
	return RUNNER_ENTRY in out ? out : null
}

/**
 * The pin stored in fleet:config, or null when unset or invalid (launch then
 * refuses). `runner_files`, when present, is the whole manifest and takes
 * precedence; otherwise `runner_sha256` pins box-runner.mjs alone.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isSafeRef(config.runner_ref)) return null
	if (config.runner_files != null) {
		const files = parseRunnerFiles(config.runner_files)
		return files ? { ref: config.runner_ref, files } : null
	}
	if (!isSha256(config.runner_sha256)) return null
	return { ref: config.runner_ref, files: { [RUNNER_ENTRY]: config.runner_sha256 } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

function dirOf(path: string): string | null {
	const i = path.lastIndexOf('/')
	return i === -1 ? null : path.slice(0, i)
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify all
 * hashes → install into the same relative layout. Aborts non-zero on any
 * missing file or mismatch (callers run under `set -euo pipefail`), leaving
 * nothing installed. No fallback to a baked copy — fail closed is the point.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isSafeRef(pin.ref)) throw new Error('runner pin: unsafe ref')
	const files = parseRunnerFiles(pin.files)
	if (!files)
		throw new Error(`runner pin: manifest must map safe paths (incl. ${RUNNER_ENTRY}) to sha256`)
	const base = opts.baseUrl ?? `https://raw.githubusercontent.com/abel30567/fermi-daemon/${pin.ref}`
	const dest = opts.destDir ?? '/opt/fermi'
	const stage = `${dest}/.runner-stage`
	const paths = Object.keys(files).sort()
	const dirs = [...new Set(paths.map(dirOf).filter((d): d is string => d !== null))].sort()
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}'`,
		...dirs.map((d) => `mkdir -p '${stage}/${d}'`),
		// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
		// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
		// throttling; the sha256 gate still catches anything short or tampered.
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${base}/${p}' -o '${stage}/${p}'`,
		),
		`printf '%s\\n' ${paths.map((p) => `'${files[p]}  ${stage}/${p}'`).join(' ')} | sha256sum -c - >/dev/null`,
		...dirs.map((d) => `mkdir -p '${dest}/${d}'`),
		...paths.map((p) => `mv '${stage}/${p}' '${dest}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
