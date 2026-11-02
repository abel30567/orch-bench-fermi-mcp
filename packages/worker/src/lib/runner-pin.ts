/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched runner file's sha256 BEFORE the box token is materialized — a
 * tampered, missing or unpinned file never sees credentials and the box fails
 * closed (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * ship shared daemon modules (`harness/`, `lib/`) alongside its entry point.
 * Legacy single-file pins (`runner_sha256` only) map to `{ 'box-runner.mjs': sha }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path in fermi-daemon at `ref` → sha256 hex. Always includes `box-runner.mjs`. */
	files: Record<string, string>
}

export const RUNNER_ENTRY = 'box-runner.mjs'
export const MAX_RUNNER_FILES = 32

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const SHA256_RE = /^[0-9a-f]{64}$/
// Each segment starts with an alphanumeric or underscore: rules out `.`, `..`
// and hidden files. Only shell- and URL-inert characters are allowed.
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	const segments = path.split('/')
	return segments.length <= 8 && segments.every((s) => SEGMENT_RE.test(s))
}

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/** A manifest is a non-empty `{ safePath: sha256 }` map that contains `box-runner.mjs`. */
export function isValidRunnerFiles(files: unknown): files is Record<string, string> {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return false
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_RUNNER_FILES) return false
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return false
	return entries.every(
		([path, sha]) => isSafeRunnerPath(path) && typeof sha === 'string' && SHA256_RE.test(sha),
	)
}

/**
 * Resolve the pin from fleet:config. A present `runner_files` manifest wins and
 * must be valid on its own (an invalid one never falls back to the legacy
 * single-file pin). Returns null when the pin is unset or invalid.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isValidRunnerRef(config.runner_ref)) return null
	if (config.runner_files !== undefined && config.runner_files !== null) {
		if (!isValidRunnerFiles(config.runner_files)) return null
		return { ref: config.runner_ref, files: { ...config.runner_files } }
	}
	if (typeof config.runner_sha256 !== 'string' || !SHA256_RE.test(config.runner_sha256)) return null
	return { ref: config.runner_ref, files: { [RUNNER_ENTRY]: config.runner_sha256 } }
}

const RUNNER_REPO_RAW = 'https://raw.githubusercontent.com/abel30567/fermi-daemon'

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `${RUNNER_REPO_RAW}/${ref}/${path}`
}

/**
 * Bash fragment: fetch every file into a staging dir → verify every hash →
 * install into the same relative layout. Aborts non-zero on any missing or
 * mismatched file (callers run under `set -euo pipefail`) before anything is
 * installed. No fallback to a baked copy — fail closed is the point.
 * Throws on an invalid manifest.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isValidRunnerRef(pin.ref)) throw new Error('invalid runner pin: bad ref')
	if (!isValidRunnerFiles(pin.files)) throw new Error('invalid runner pin: bad files manifest')
	const base = opts.baseUrl ?? `${RUNNER_REPO_RAW}/${pin.ref}`
	const dest = opts.destDir ?? '/opt/fermi'
	const stage = `${dest}/.runner.new`
	const paths = Object.keys(pin.files).sort()
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	return [
		`rm -rf '${stage}'`,
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors --create-dirs '${base}/${p}' -o '${stage}/${p}'`,
		),
		...paths.map((p) => `echo '${pin.files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`),
		...paths.map((p) => {
			const dir = p.includes('/') ? `${dest}/${p.slice(0, p.lastIndexOf('/'))}` : dest
			return `mkdir -p '${dir}' && mv '${stage}/${p}' '${dest}/${p}'`
		}),
		`rm -rf '${stage}'`,
	].join('\n')
}
