/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file never sees credentials and the box fails closed
 * (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ref, files: {path: sha256}}` so box-runner can ship
 * with shared daemon modules (`harness/`, `lib/`). A legacy single-file pin is
 * the manifest `{'box-runner.mjs': sha256}`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path in the daemon repo → sha256 hex. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_RE = /^[0-9a-f]{64}$/
// Relative, slash-separated; no segment may be empty or start with a dot (so
// no `.`, `..`, hidden files, absolute paths, or shell metacharacters).
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const MAX_FILES = 64

export function isSafeRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref) && !ref.includes('..')
}

export function isSafeRunnerPath(path: unknown): path is string {
	return (
		typeof path === 'string' &&
		path.length <= 256 &&
		path.split('/').every((segment) => SEGMENT_RE.test(segment))
	)
}

/** Validate a `{path: sha256}` manifest; returns the reason it is invalid, or null. */
export function runnerFilesError(files: unknown): string | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return 'files must be an object'
	const entries = Object.entries(files)
	if (entries.length > MAX_FILES) return `files must have at most ${MAX_FILES} entries`
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return `files must contain ${RUNNER_ENTRY}`
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path)) return `unsafe path: ${JSON.stringify(path)}`
		if (typeof sha !== 'string' || !SHA256_RE.test(sha))
			return `sha256 for ${path} must be 64 lowercase hex chars`
	}
	return null
}

/**
 * The pin stored in fleet:config, or null when unset or invalid (launch must
 * then refuse). `runner_files` is the manifest; without it the legacy
 * `runner_sha256` pins box-runner.mjs alone.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isSafeRunnerRef(config.runner_ref)) return null
	const ref = config.runner_ref
	if (config.runner_files != null) {
		if (runnerFilesError(config.runner_files) !== null) return null
		const files = { ...(config.runner_files as Record<string, string>) }
		// Both fields set but disagreeing means a corrupted pin: fail closed.
		if (config.runner_sha256 != null && config.runner_sha256 !== files[RUNNER_ENTRY]) return null
		return { ref, files }
	}
	if (typeof config.runner_sha256 !== 'string' || !SHA256_RE.test(config.runner_sha256)) return null
	return { ref, files: { [RUNNER_ENTRY]: config.runner_sha256 } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify every
 * sha256 → install into the same relative layout under `destDir`. Aborts
 * non-zero on any missing or mismatched file (callers run under
 * `set -euo pipefail`) before anything is installed. No fallback to a baked
 * copy — fail closed is the point. Throws on an invalid manifest.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isSafeRunnerRef(pin.ref)) throw new Error(`invalid runner ref: ${JSON.stringify(pin.ref)}`)
	const filesError = runnerFilesError(pin.files)
	if (filesError) throw new Error(`invalid runner manifest: ${filesError}`)
	const destDir = opts.destDir ?? '/opt/fermi'
	const urlFor = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl}/${path}` : runnerUrl(pin.ref, path)
	const stage = '"$FERMI_RUNNER_STAGE"'
	const paths = Object.keys(pin.files).sort()
	const dirs = [
		...new Set(paths.filter((p) => p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/')))),
	]
	return [
		'FERMI_RUNNER_STAGE=$(mktemp -d "${TMPDIR:-/tmp}/fermi-runner.XXXXXX")',
		...dirs.map((dir) => `mkdir -p ${stage}/'${dir}'`),
		// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
		// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
		// throttling; the sha256 gate still catches anything short or tampered.
		...paths.map(
			(path) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${urlFor(path)}' -o ${stage}/'${path}'`,
		),
		...paths.map(
			(path) =>
				`echo "${pin.files[path]}  $FERMI_RUNNER_STAGE/${path}" | sha256sum -c - >/dev/null`,
		),
		...dirs.map((dir) => `mkdir -p '${destDir}/${dir}'`),
		...paths.map((path) => `mv ${stage}/'${path}' '${destDir}/${path}'`),
		`rm -rf ${stage}`,
	].join('\n')
}
