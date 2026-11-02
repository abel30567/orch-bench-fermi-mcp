/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched runner file's sha256 BEFORE the box token is materialized — a
 * tampered, missing or unpinned file means nothing is installed, credentials
 * never land and the box fails closed (never heartbeats; the provision-grace
 * reaper path reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * ship with the daemon's shared modules (`harness/`, `lib/`). A legacy
 * single-file pin (`runner_sha256` only) is the manifest
 * `{ 'box-runner.mjs': runner_sha256 }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Path (relative to the repo root) → sha256 hex. Always includes box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_RE = /^[0-9a-f]{64}$/
// Each segment: no leading dot (rules out `.`, `..` and the staging dir), and
// only characters that are inert inside single-quoted shell and URL paths.
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const MAX_FILES = 64

export function isSafeRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

export function isSafeRunnerPath(path: unknown): path is string {
	return (
		typeof path === 'string' &&
		path.length > 0 &&
		path.length <= 256 &&
		path.split('/').every((seg) => SEGMENT_RE.test(seg))
	)
}

export function isSha256Hex(v: unknown): v is string {
	return typeof v === 'string' && SHA256_RE.test(v)
}

/** A manifest is valid when it is a non-empty map of safe paths to sha256 hex and contains box-runner.mjs. */
export function isValidRunnerManifest(files: unknown): files is Record<string, string> {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return false
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_FILES) return false
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return false
	return entries.every(([path, sha]) => isSafeRunnerPath(path) && isSha256Hex(sha))
}

/**
 * Read the pin out of fleet:config. Returns null when unset or invalid —
 * callers treat both as "refuse to launch".
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	const { runner_ref: ref, runner_sha256: sha256, runner_files: files } = config
	if (!isSafeRunnerRef(ref)) return null
	if (files !== undefined && files !== null) {
		if (!isValidRunnerManifest(files)) return null
		// A stale legacy hash disagreeing with the manifest is ambiguous: fail closed.
		if (sha256 !== undefined && sha256 !== null && sha256 !== files[RUNNER_ENTRY]) return null
		return { ref, files: { ...files } }
	}
	if (!isSha256Hex(sha256)) return null
	return { ref, files: { [RUNNER_ENTRY]: sha256 } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify every
 * hash → install into the same relative layout under `destDir`. Aborts
 * non-zero on any fetch failure or mismatch (callers run under
 * `set -euo pipefail`) before anything is installed. No fallback to a baked
 * copy — fail closed is the point.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isSafeRunnerRef(pin.ref)) throw new Error('invalid runner pin ref')
	if (!isValidRunnerManifest(pin.files)) throw new Error('invalid runner pin manifest')
	const base = (opts.baseUrl ?? runnerUrl(pin.ref, '')).replace(/\/+$/, '')
	const dest = (opts.destDir ?? '/opt/fermi').replace(/\/+$/, '')
	const stage = `${dest}/.runner-stage`
	const paths = Object.keys(pin.files).sort()
	const parentDirs = (root: string) => [
		...new Set(
			paths
				.filter((p) => p.includes('/'))
				.map((p) => `'${root}/${p.slice(0, p.lastIndexOf('/'))}'`),
		),
	]
	const stageDirs = parentDirs(stage)
	const destDirs = parentDirs(dest)
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}'${stageDirs.length ? ` ${stageDirs.join(' ')}` : ''}`,
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${base}/${p}' -o '${stage}/${p}'`,
		),
		...paths.map((p) => `echo '${pin.files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`),
		...(destDirs.length ? [`mkdir -p ${destDirs.join(' ')}`] : []),
		...paths.map((p) => `mv '${stage}/${p}' '${dest}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
