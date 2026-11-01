/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file never sees credentials and the box fails closed
 * (never heartbeats; the provision-grace reaper path reclaims it).
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
	/** Relative path in the daemon repo → sha256 hex. Must contain box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9._-]{1,128}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/
const MAX_FILES = 64

export function isSafeRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref) && ref !== '.' && ref !== '..'
}

/** Relative, no `.`/`..`/empty segments, shell- and URL-safe characters only. */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 256) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg) && seg !== '.' && seg !== '..')
}

export function isValidRunnerPin(pin: unknown): pin is RunnerPin {
	if (!pin || typeof pin !== 'object') return false
	const { ref, files } = pin as { ref?: unknown; files?: unknown }
	if (!isSafeRunnerRef(ref)) return false
	if (!files || typeof files !== 'object' || Array.isArray(files)) return false
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_FILES) return false
	if (!Object.prototype.hasOwnProperty.call(files, RUNNER_ENTRY)) return false
	return entries.every(
		([p, h]) => isSafeRunnerPath(p) && typeof h === 'string' && SHA256_RE.test(h),
	)
}

/**
 * Resolve the pin from fleet:config. `runner_files` (manifest) wins over the
 * legacy `runner_sha256`. Returns null when unset or invalid — callers must
 * refuse to launch (fail closed).
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	const ref = config.runner_ref
	if (ref === null || ref === undefined) return null
	let files: unknown
	if (config.runner_files !== null && config.runner_files !== undefined) {
		files = config.runner_files
	} else if (config.runner_sha256 !== null && config.runner_sha256 !== undefined) {
		files = { [RUNNER_ENTRY]: config.runner_sha256 }
	} else {
		return null
	}
	const pin = { ref, files }
	return isValidRunnerPin(pin) ? { ref: pin.ref, files: { ...pin.files } } : null
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

function dirOf(path: string): string | null {
	const i = path.lastIndexOf('/')
	return i === -1 ? null : path.slice(0, i)
}

/**
 * Bash fragment: fetch every file into a staging dir → verify every hash →
 * install into the same relative layout. Aborts non-zero on any missing or
 * mismatched file (callers run under `set -euo pipefail`) before anything is
 * installed. No fallback to a baked copy — fail closed is the point.
 *
 * `baseUrl` overrides the per-ref raw GitHub prefix (test harness only).
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isValidRunnerPin(pin)) throw new Error('invalid runner pin manifest')
	const destDir = opts.destDir ?? '/opt/fermi'
	const stage = `${destDir}/.runner-staging`
	const urlFor = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl.replace(/\/+$/, '')}/${path}` : runnerUrl(pin.ref, path)
	// Entry last so a partially-installed tree never has a runnable entrypoint.
	const paths = Object.keys(pin.files).sort((a, b) =>
		a === RUNNER_ENTRY ? 1 : b === RUNNER_ENTRY ? -1 : a < b ? -1 : a > b ? 1 : 0,
	)
	const stageDirs = [...new Set(paths.map(dirOf).filter((d): d is string => d !== null))]
	const lines = [`rm -rf '${stage}'`, `mkdir -p '${stage}'`]
	for (const d of stageDirs) lines.push(`mkdir -p '${stage}/${d}'`)
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	for (const p of paths) {
		lines.push(
			`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${urlFor(p)}' -o '${stage}/${p}'`,
		)
	}
	for (const p of paths) {
		lines.push(`echo '${pin.files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`)
	}
	for (const d of stageDirs) lines.push(`mkdir -p '${destDir}/${d}'`)
	for (const p of paths) lines.push(`mv '${stage}/${p}' '${destDir}/${p}'`)
	lines.push(`rm -rf '${stage}'`)
	return lines.join('\n')
}
