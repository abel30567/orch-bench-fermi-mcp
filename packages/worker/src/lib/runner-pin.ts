/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched runner file's sha256 BEFORE the box token is materialized — a
 * tampered, missing or unpinned file means the runner never sees credentials
 * and the box fails closed (never heartbeats; the provision-grace reaper path
 * reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * import shared daemon modules (`harness/`, `lib/`). A legacy single-file pin
 * (`runner_ref` + `runner_sha256`) is the manifest `{ 'box-runner.mjs': sha }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path (from the repo root at `ref`) → sha256 hex. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const SHA256_RE = /^[0-9a-f]{64}$/
const REF_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/
const SEGMENT_RE = /^[0-9A-Za-z_][0-9A-Za-z._-]{0,127}$/
const MAX_FILES = 64

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref) && !ref.includes('..')
}

/** Relative, `/`-separated, no `.`/`..`/empty segments, shell- and URL-safe characters only. */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 256) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg) && seg !== '.' && seg !== '..')
}

export function isValidRunnerManifest(files: unknown): files is Record<string, string> {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return false
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_FILES) return false
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return false
	return entries.every(
		([path, sha]) => isSafeRunnerPath(path) && typeof sha === 'string' && SHA256_RE.test(sha),
	)
}

export function isValidRunnerPin(pin: unknown): pin is RunnerPin {
	if (!pin || typeof pin !== 'object') return false
	const p = pin as { ref?: unknown; files?: unknown }
	return isValidRunnerRef(p.ref) && isValidRunnerManifest(p.files)
}

/**
 * Read the pin out of fleet:config. Null when unset or invalid (fail closed).
 * `runner_files` (manifest) wins when present; it must agree with
 * `runner_sha256` if both are set. Otherwise the legacy single-file pin applies.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	const ref = config.runner_ref
	if (!isValidRunnerRef(ref)) return null
	const manifest = config.runner_files
	if (manifest !== undefined && manifest !== null) {
		if (!isValidRunnerManifest(manifest)) return null
		const sha = config.runner_sha256
		if (sha !== undefined && sha !== null && sha !== manifest[RUNNER_ENTRY]) return null
		return { ref, files: { ...manifest } }
	}
	const sha = config.runner_sha256
	if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
	return { ref, files: { [RUNNER_ENTRY]: sha } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

function dirOf(path: string): string | null {
	const i = path.lastIndexOf('/')
	return i === -1 ? null : path.slice(0, i)
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify every
 * hash → install into the same relative layout under `dir`. Aborts non-zero on
 * any missing or mismatched file (callers run under `set -euo pipefail`),
 * leaving nothing installed. No fallback to a baked copy — fail closed is the
 * point. Throws on an invalid pin so a bad manifest never reaches user-data.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; dir?: string } = {},
): string {
	if (!isValidRunnerPin(pin)) throw new Error('invalid runner pin manifest')
	const dir = opts.dir ?? '/opt/fermi'
	if (/['\n]/.test(dir)) throw new Error('invalid runner install dir')
	if (opts.baseUrl !== undefined && /['\n]/.test(opts.baseUrl))
		throw new Error('invalid runner base url')
	const url = (path: string) =>
		opts.baseUrl === undefined ? runnerUrl(pin.ref, path) : `${opts.baseUrl}/${path}`
	const stage = `${dir}/.runner-new`
	const paths = Object.keys(pin.files).sort()
	const dirs = [...new Set(paths.map(dirOf).filter((d): d is string => d !== null))]
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}'`,
		...dirs.map((d) => `mkdir -p '${stage}/${d}'`),
		// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
		// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
		// throttling; the sha256 gate still catches anything short or tampered.
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${url(p)}' -o '${stage}/${p}'`,
		),
		`(cd '${stage}' && printf '%s\\n' ${paths.map((p) => `'${pin.files[p]}  ${p}'`).join(' ')} | sha256sum -c - >/dev/null)`,
		...dirs.map((d) => `mkdir -p '${dir}/${d}'`),
		...paths.map((p) => `mv '${stage}/${p}' '${dir}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
