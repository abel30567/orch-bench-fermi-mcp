/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file never sees credentials and the box fails closed
 * (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * ship with shared daemon modules (`harness/`, `lib/`). A legacy single-file
 * pin (`runner_ref` + `runner_sha256`) is the manifest `{ 'box-runner.mjs': sha }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Repo-relative path → sha256 hex at that ref. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const MAX_FILES = 100

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref) && !ref.includes('..')
}

/**
 * Relative path made only of plain segments: no absolute paths, no `.`/`..`,
 * no empty segments, no shell metacharacters (paths are interpolated into the
 * boot script and must stay under the install dir).
 */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg) && seg !== '..')
}

/** Validate a `{ path: sha256 }` manifest; null when malformed or missing box-runner.mjs. */
export function validateRunnerFiles(files: unknown): Record<string, string> | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return null
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_FILES) return null
	const out: Record<string, string> = {}
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path) || typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
		out[path] = sha
	}
	if (!(RUNNER_ENTRY in out)) return null
	return out
}

/**
 * Read the pin from fleet:config. `runner_files` (manifest) wins; otherwise a
 * legacy `runner_sha256` pins box-runner.mjs alone. Null when unset or invalid.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isValidRunnerRef(config.runner_ref)) return null
	if (config.runner_files !== undefined && config.runner_files !== null) {
		const files = validateRunnerFiles(config.runner_files)
		return files ? { ref: config.runner_ref, files } : null
	}
	const sha = config.runner_sha256
	if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
	return { ref: config.runner_ref, files: { [RUNNER_ENTRY]: sha } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every file → verify every hash → install. Aborts
 * non-zero on any missing file or mismatch (callers run under
 * `set -euo pipefail`) and installs nothing unless ALL files verified. No
 * fallback to a baked copy — fail closed is the point. Throws on an invalid
 * manifest so a bad pin can never render a boot script.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; dir?: string } = {},
): string {
	if (!isValidRunnerRef(pin.ref)) throw new Error('invalid runner pin: bad ref')
	const files = validateRunnerFiles(pin.files)
	if (!files) throw new Error('invalid runner pin: malformed files manifest')
	const base = opts.baseUrl ?? `https://raw.githubusercontent.com/abel30567/fermi-daemon/${pin.ref}`
	const dir = opts.dir ?? '/opt/fermi'
	const paths = Object.keys(files).sort()
	const subdirs = [
		...new Set(paths.filter((p) => p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/')))),
	]
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	return [
		...subdirs.map((d) => `mkdir -p '${dir}/${d}'`),
		...paths.flatMap((p) => [
			`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${base}/${p}' -o '${dir}/${p}.new'`,
			`echo '${files[p]}  ${dir}/${p}.new' | sha256sum -c - >/dev/null`,
		]),
		...paths.map((p) => `mv '${dir}/${p}.new' '${dir}/${p}'`),
	].join('\n')
}
