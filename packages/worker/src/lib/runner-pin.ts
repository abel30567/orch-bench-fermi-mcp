/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file never sees credentials and the box fails closed
 * (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner.mjs
 * can import shared daemon modules (`harness/`, `lib/`). A legacy single-file
 * pin (`runner_ref` + `runner_sha256` only) is read as `{ box-runner.mjs }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path in fermi-daemon at `ref` → sha256 hex. Always includes box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9._-]{1,64}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref) && !/^\.+$/.test(ref)
}

/**
 * Relative, normalized path made only of shell- and URL-safe characters: no
 * leading `/`, no empty, `.` or `..` segments. Paths are interpolated into
 * single-quoted bash and into the raw URL, so the charset is the safety.
 */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..')
}

/** Validated copy of a manifest's files, or null when anything is off. */
export function validRunnerFiles(files: unknown): Record<string, string> | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return null
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > 100) return null
	const out: Record<string, string> = {}
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path) || typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
		out[path] = sha
	}
	if (!out[RUNNER_ENTRY]) return null
	return out
}

/**
 * The effective pin from fleet:config, or null when unset or invalid (launch
 * then refuses). `runner_files` wins when present; otherwise the legacy
 * `runner_sha256` pins box-runner.mjs alone.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isValidRunnerRef(config.runner_ref)) return null
	if (config.runner_files !== undefined && config.runner_files !== null) {
		const files = validRunnerFiles(config.runner_files)
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
 * Bash fragment: fetch every file into a staging dir → verify every sha256 →
 * install into the same relative layout under `destDir`. Any missing file
 * (curl -f) or mismatch aborts non-zero before anything is installed (callers
 * run under `set -euo pipefail`). No fallback to a baked copy — fail closed is
 * the point. Throws on an invalid manifest so it can never emit a weak script.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isValidRunnerRef(pin?.ref)) throw new Error('invalid runner pin: bad ref')
	const files = validRunnerFiles(pin.files)
	if (!files) throw new Error('invalid runner pin: bad files manifest')
	const url = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl}/${path}` : runnerUrl(pin.ref, path)
	const dest = opts.destDir ?? '/opt/fermi'
	const stage = `${dest}/.runner-staging`
	const paths = Object.keys(files).sort()
	const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
	const subdirs = [...new Set(paths.map(dirOf).filter(Boolean))]
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}'`,
		...subdirs.map((d) => `mkdir -p '${stage}/${d}'`),
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${url(p)}' -o '${stage}/${p}'`,
		),
		`(cd '${stage}' && printf '%s\\n' ${paths.map((p) => `'${files[p]}  ${p}'`).join(' ')} | sha256sum -c - >/dev/null)`,
		...subdirs.map((d) => `mkdir -p '${dest}/${d}'`),
		...paths.map((p) => `mv '${stage}/${p}' '${dest}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
