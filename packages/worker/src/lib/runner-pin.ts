/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * pinned file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned runner never sees credentials and the box fails closed
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
	/** Commit SHA in abel30567/fermi-daemon. */
	ref: string
	/** Relative path at that ref → sha256 hex. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[0-9a-f]{7,40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const MAX_FILES = 64

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/**
 * Relative, `/`-separated, no empty/`.`/`..` segments, and a conservative
 * charset: paths are interpolated into single-quoted shell words and URLs.
 */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg) && seg !== '.' && seg !== '..')
}

/** Why `files` is not a valid manifest, or null when it is. */
export function runnerFilesError(files: unknown): string | null {
	if (!files || typeof files !== 'object' || Array.isArray(files))
		return 'files must be an object of path → sha256'
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length > MAX_FILES) return `files may list at most ${MAX_FILES} paths`
	if (!Object.prototype.hasOwnProperty.call(files, RUNNER_ENTRY))
		return `files must include ${RUNNER_ENTRY}`
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path)) return `unsafe path: ${JSON.stringify(path)}`
		if (typeof sha !== 'string' || !SHA256_RE.test(sha))
			return `sha256 for ${path} must be 64 lowercase hex chars`
	}
	return null
}

/**
 * Read the pin out of fleet:config. Returns null when unset or invalid, so
 * the provisioner fails closed. `runner_files`, when present, wins; its
 * box-runner.mjs hash must agree with `runner_sha256` if that is also set.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isValidRunnerRef(config.runner_ref)) return null
	const ref = config.runner_ref
	if (config.runner_files !== undefined && config.runner_files !== null) {
		if (runnerFilesError(config.runner_files) !== null) return null
		const files = { ...(config.runner_files as Record<string, string>) }
		if (
			config.runner_sha256 !== undefined &&
			config.runner_sha256 !== null &&
			config.runner_sha256 !== files[RUNNER_ENTRY]
		)
			return null
		return { ref, files }
	}
	if (typeof config.runner_sha256 !== 'string' || !SHA256_RE.test(config.runner_sha256)) return null
	return { ref, files: { [RUNNER_ENTRY]: config.runner_sha256 } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every pinned file into a staging dir → verify every
 * hash → install into the same relative layout under `dir`. Aborts non-zero
 * on any missing or mismatched file (callers run under `set -euo pipefail`),
 * leaving nothing installed. No fallback to a baked copy — fail closed is the
 * point. Throws on an invalid manifest rather than emit an unverifiable script.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; dir?: string } = {},
): string {
	if (!isValidRunnerRef(pin.ref)) throw new Error('invalid runner pin: bad ref')
	const err = runnerFilesError(pin.files)
	if (err) throw new Error(`invalid runner pin: ${err}`)
	const base = opts.baseUrl ?? runnerUrl(pin.ref, '').replace(/\/$/, '')
	const dir = opts.dir ?? '/opt/fermi'
	const stage = `${dir}/.runner.new`
	// Entry first, then the rest in a stable order.
	const paths = Object.keys(pin.files).sort((a, b) =>
		a === RUNNER_ENTRY ? -1 : b === RUNNER_ENTRY ? 1 : a < b ? -1 : a > b ? 1 : 0,
	)
	const parent = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
	const dirs = [...new Set(paths.map(parent).filter(Boolean))]
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}'`,
		...dirs.map((d) => `mkdir -p '${stage}/${d}'`),
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${base}/${p}' -o '${stage}/${p}'`,
		),
		...paths.map((p) => `echo '${pin.files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`),
		...dirs.map((d) => `mkdir -p '${dir}/${d}'`),
		...paths.map((p) => `mv '${stage}/${p}' '${dir}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
