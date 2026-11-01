/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies the
 * fetched runner's sha256 BEFORE the box token is materialized — a tampered
 * or unpinned runner never sees credentials and the box fails closed (never
 * heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ref, files: {path: sha256}}` so box-runner can ship
 * with shared daemon modules (`harness/`, `lib/`). Every file is fetched into
 * the same relative layout and every hash is checked before anything installs.
 * A legacy single-file pin (`runner_ref` + `runner_sha256`) is the manifest
 * `{ 'box-runner.mjs': runner_sha256 }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'
export const MAX_RUNNER_FILES = 64

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Repo-relative path → sha256 hex at that ref. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const SHA256_RE = /^[0-9a-f]{64}$/
// Interpolated into a URL and single-quoted shell words: keep to a safe charset.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

export function isSafeRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/** Relative, no `.`/`..`/empty segments, no leading slash, shell- and URL-safe. */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg) && seg !== '.' && seg !== '..')
}

/** Validates a `{path: sha256}` manifest; returns an error string or null. */
export function runnerFilesError(files: unknown): string | null {
	if (!files || typeof files !== 'object' || Array.isArray(files))
		return 'files must be an object of path -> sha256'
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length > MAX_RUNNER_FILES) return `files may list at most ${MAX_RUNNER_FILES} paths`
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return `files must include ${RUNNER_ENTRY}`
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path)) return `unsafe path: ${path}`
		if (typeof sha !== 'string' || !SHA256_RE.test(sha))
			return `sha256 for ${path} must be 64 lowercase hex`
	}
	return null
}

function validPin(pin: RunnerPin): boolean {
	return isSafeRunnerRef(pin.ref) && runnerFilesError(pin.files) === null
}

/**
 * Pin from fleet:config, or null when unset or invalid. `runner_files`, when
 * present, is the manifest and must agree with `runner_sha256` (if set) on
 * box-runner.mjs; otherwise the legacy single-file pin applies.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	const ref = config.runner_ref
	if (!isSafeRunnerRef(ref)) return null
	let files: Record<string, string>
	if (config.runner_files != null) {
		if (runnerFilesError(config.runner_files)) return null
		files = { ...(config.runner_files as Record<string, string>) }
		if (config.runner_sha256 != null && config.runner_sha256 !== files[RUNNER_ENTRY]) return null
	} else {
		if (typeof config.runner_sha256 !== 'string') return null
		files = { [RUNNER_ENTRY]: config.runner_sha256 }
	}
	const pin = { ref, files }
	return validPin(pin) ? pin : null
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify every
 * hash → install into the same relative layout. Aborts non-zero on any missing
 * or mismatched file (callers run under `set -euo pipefail`) before anything
 * is installed. No fallback to a baked copy — fail closed is the point.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; dir?: string } = {},
): string {
	if (!validPin(pin)) throw new Error('invalid runner pin manifest')
	const base = opts.baseUrl ?? runnerUrl(pin.ref, '').replace(/\/$/, '')
	const dir = opts.dir ?? '/opt/fermi'
	const stage = `${dir}/.runner-stage`
	const paths = Object.keys(pin.files).sort()
	const subdirs = [...new Set(paths.filter((p) => p.includes('/')).map(parentDir))].sort()
	const lines = [`rm -rf '${stage}'`, `mkdir -p '${stage}'`]
	for (const sub of subdirs) lines.push(`mkdir -p '${stage}/${sub}'`)
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	for (const p of paths)
		lines.push(
			`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${base}/${p}' -o '${stage}/${p}'`,
		)
	for (const p of paths)
		lines.push(`echo '${pin.files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`)
	// Install only after every file verified.
	for (const sub of subdirs) lines.push(`mkdir -p '${dir}/${sub}'`)
	for (const p of paths) lines.push(`mv '${stage}/${p}' '${dir}/${p}'`)
	lines.push(`rm -rf '${stage}'`)
	return lines.join('\n')
}

function parentDir(path: string): string {
	return path.slice(0, path.lastIndexOf('/'))
}
