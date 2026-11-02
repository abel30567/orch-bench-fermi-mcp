/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file never sees credentials and the box fails closed
 * (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ref, files: {path: sha256}}` so box-runner can ship
 * with shared daemon modules (`harness/`, `lib/`). A legacy single-file pin
 * (`runner_sha256` only) is the manifest `{'box-runner.mjs': sha256}`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path in the daemon repo → sha256 hex at that ref. Always includes box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_RE = /^[0-9a-f]{64}$/
// No leading dot: rules out `.`/`..` traversal and hidden staging collisions.
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
export const MAX_RUNNER_FILES = 64

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 256) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg))
}

export function isValidSha256(sha: unknown): sha is string {
	return typeof sha === 'string' && SHA256_RE.test(sha)
}

/** Returns an error string for an invalid manifest, else null. */
export function runnerManifestError(files: unknown): string | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return 'files must be an object'
	const entries = Object.entries(files)
	if (entries.length > MAX_RUNNER_FILES) return `files exceeds ${MAX_RUNNER_FILES} entries`
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return `files must include ${RUNNER_ENTRY}`
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path)) return `unsafe path: ${JSON.stringify(path)}`
		if (!isValidSha256(sha)) return `invalid sha256 for ${path}`
	}
	return null
}

/**
 * Read the pin from fleet:config. `runner_files` (manifest) wins over the
 * legacy `runner_sha256`; null when unset or invalid (launch then refuses).
 */
export function runnerPinFromConfig(config: {
	runner_ref?: string | null
	runner_sha256?: string | null
	runner_files?: Record<string, string> | null
}): RunnerPin | null {
	if (!isValidRunnerRef(config.runner_ref)) return null
	if (config.runner_files != null) {
		if (runnerManifestError(config.runner_files) !== null) return null
		return { ref: config.runner_ref, files: { ...config.runner_files } }
	}
	if (!isValidSha256(config.runner_sha256)) return null
	return { ref: config.runner_ref, files: { [RUNNER_ENTRY]: config.runner_sha256 } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every file into a staging dir → verify every hash →
 * install into the same relative layout under `destDir`. Aborts non-zero on
 * any missing or mismatched file (callers run under `set -euo pipefail`)
 * before anything is installed. No fallback to a baked copy — fail closed is
 * the point.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isValidRunnerRef(pin.ref)) throw new Error('invalid runner ref')
	const err = runnerManifestError(pin.files)
	if (err) throw new Error(`invalid runner manifest: ${err}`)
	const base = opts.baseUrl ?? runnerUrl(pin.ref, '').replace(/\/$/, '')
	const destDir = opts.destDir ?? '/opt/fermi'
	const stage = `${destDir}/.runner-staging`
	const paths = Object.keys(pin.files).sort()
	const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
	const subdirs = [...new Set(paths.map(dirOf).filter(Boolean))]
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}'${subdirs.map((d) => ` '${stage}/${d}'`).join('')}`,
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${base}/${p}' -o '${stage}/${p}'`,
		),
		...paths.map((p) => `echo '${pin.files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`),
		...subdirs.map((d) => `mkdir -p '${destDir}/${d}'`),
		...paths.map((p) => `mv '${stage}/${p}' '${destDir}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
