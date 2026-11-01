/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file never sees credentials and the box fails closed
 * (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * import shared daemon modules (`harness/`, `lib/`). Every file is fetched
 * into the same relative layout under the install dir. A legacy single-file
 * pin (`runner_ref` + `runner_sha256`, no `runner_files`) is the manifest
 * `{ 'box-runner.mjs': runner_sha256 }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path (from the repo root) -> sha256 hex. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
const MAX_FILES = 64

/** Ref safe to embed in a URL and a single-quoted shell string. */
export function isSafeRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/**
 * Relative path with no traversal: `/`-separated segments of
 * `[A-Za-z0-9._-]`, none empty, `.` or `..`, none starting with `.` or `-`
 * (no hidden files, no option-like names). Shell- and URL-safe by construction.
 */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 256) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg))
}

/** Validate a `{ path: sha256 }` manifest; null when malformed or missing box-runner.mjs. */
export function parseRunnerFiles(files: unknown): Record<string, string> | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return null
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_FILES) return null
	const out: Record<string, string> = {}
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path)) return null
		if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
		out[path] = sha
	}
	if (!(RUNNER_ENTRY in out)) return null
	return out
}

/**
 * Resolve the pin stored in fleet:config. `runner_files` (when set) is the
 * manifest; otherwise `runner_sha256` pins box-runner.mjs alone (legacy).
 * Returns null when the pin is unset or invalid — launch must refuse.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isSafeRef(config.runner_ref)) return null
	if (config.runner_files !== undefined && config.runner_files !== null) {
		const files = parseRunnerFiles(config.runner_files)
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
 * non-zero on any missing or mismatched file (callers run under
 * `set -euo pipefail`), and only moves files into place after ALL of them
 * verified, so a partial manifest is never installed. No fallback to a baked
 * copy — fail closed is the point. Throws on an invalid manifest.
 *
 * `opts.baseUrl` replaces `https://raw.githubusercontent.com/.../<ref>` (tests).
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!pin || !isSafeRef(pin.ref)) throw new Error('runner pin: invalid ref')
	const files = parseRunnerFiles(pin.files)
	if (!files) throw new Error('runner pin: invalid manifest')
	const destDir = opts.destDir ?? '/opt/fermi'
	const urlFor = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl}/${path}` : runnerUrl(pin.ref, path)
	// Deterministic order; box-runner.mjs is installed last so the entrypoint
	// never exists without its modules.
	const paths = Object.keys(files).sort((a, b) =>
		a === RUNNER_ENTRY ? 1 : b === RUNNER_ENTRY ? -1 : a < b ? -1 : a > b ? 1 : 0,
	)
	const dirs = [...new Set(paths.map((p) => p.split('/').slice(0, -1).join('/')).filter(Boolean))]
	const lines: string[] = []
	if (dirs.length > 0) lines.push(`mkdir -p ${dirs.map((d) => `'${destDir}/${d}'`).join(' ')}`)
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	for (const p of paths) {
		const dest = `${destDir}/${p}`
		lines.push(
			`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${urlFor(p)}' -o '${dest}.new'`,
			`echo '${files[p]}  ${dest}.new' | sha256sum -c - >/dev/null`,
		)
	}
	for (const p of paths) lines.push(`mv '${destDir}/${p}.new' '${destDir}/${p}'`)
	return lines.join('\n')
}
