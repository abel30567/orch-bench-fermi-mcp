/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched runner file's sha256 BEFORE the box token is materialized — a
 * tampered, missing or unpinned file means the runner never sees credentials
 * and the box fails closed (never heartbeats; the provision-grace reaper path
 * reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner.mjs can
 * import shared daemon modules (`harness/`, `lib/`). A legacy single-file pin
 * (`runner_sha256` only) is read as `{ 'box-runner.mjs': runner_sha256 }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'
const MAX_FILES = 64

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path (from the repo root) → sha256 hex. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const SHA256_RE = /^[0-9a-f]{64}$/
// Refs and paths are interpolated into a single-quoted shell fragment and a URL:
// restrict both to characters that need no escaping in either.
const REF_RE = /^[A-Za-z0-9._-]{1,64}$/
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

/** Relative, forward-slash path with no `.`/`..`/empty/hidden segments. */
export function isSafeRunnerPath(path: string): boolean {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg))
}

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/** Validation error for a manifest's `files`, or null when it is well formed. */
export function runnerFilesError(files: unknown): string | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return 'files must be an object'
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length > MAX_FILES) return `files may list at most ${MAX_FILES} paths`
	if (!(RUNNER_ENTRY in files)) return `files must contain ${RUNNER_ENTRY}`
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path)) return `unsafe path: ${JSON.stringify(path)}`
		if (typeof sha !== 'string' || !SHA256_RE.test(sha))
			return `sha256 for ${path} must be 64 lowercase hex chars`
	}
	return null
}

function assertValidPin(pin: RunnerPin): void {
	if (!isValidRunnerRef(pin.ref)) throw new Error('invalid runner ref')
	const err = runnerFilesError(pin.files)
	if (err) throw new Error(`invalid runner manifest: ${err}`)
}

/**
 * Read the pin out of fleet:config. A manifest (`runner_files`) wins over the
 * legacy `runner_sha256`. Returns null when unset or invalid — callers refuse
 * to launch either way.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: string | null
	runner_sha256?: string | null
	runner_files?: Record<string, string> | null
}): RunnerPin | null {
	const ref = config.runner_ref
	if (!isValidRunnerRef(ref)) return null
	if (config.runner_files != null) {
		if (runnerFilesError(config.runner_files)) return null
		return { ref, files: { ...config.runner_files } }
	}
	const sha = config.runner_sha256
	if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
	return { ref, files: { [RUNNER_ENTRY]: sha } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every file into a staging dir → verify all hashes →
 * install into the same relative layout. Aborts non-zero on any missing file
 * or mismatch (callers run under `set -euo pipefail`) before anything is
 * installed. No fallback to a baked copy — fail closed is the point.
 *
 * `baseUrl` replaces `https://raw.githubusercontent.com/<owner>/fermi-daemon/<ref>`
 * (tests serve from file://); `dir` is the install root.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; dir?: string } = {},
): string {
	assertValidPin(pin)
	const dir = (opts.dir ?? '/opt/fermi').replace(/\/+$/, '')
	const stage = `${dir}.runner-staging`
	const url = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl}/${path}` : runnerUrl(pin.ref, path)
	const paths = Object.keys(pin.files).sort()
	const subdirs = [
		...new Set(paths.map((p) => p.split('/').slice(0, -1).join('/')).filter(Boolean)),
	]
	const checks = paths.map((p) => `${pin.files[p]}  ${p}`).join('\\n')
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}'${subdirs.map((d) => ` '${stage}/${d}'`).join('')}`,
		// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
		// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
		// throttling; the sha256 gate still catches anything short or tampered.
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${url(p)}' -o '${stage}/${p}'`,
		),
		`(cd '${stage}' && printf '${checks}\\n' | sha256sum -c - >/dev/null)`,
		`mkdir -p '${dir}'${subdirs.map((d) => ` '${dir}/${d}'`).join('')}`,
		...paths.map((p) => `mv '${stage}/${p}' '${dir}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
