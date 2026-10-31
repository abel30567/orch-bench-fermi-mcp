/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched runner file's sha256 BEFORE the box token is materialized — a
 * tampered, missing or unpinned file never sees credentials and the box fails
 * closed (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * import shared daemon modules (`harness/`, `lib/`). A legacy single-file pin
 * (`runner_ref` + `runner_sha256`) is read as `{ 'box-runner.mjs': sha256 }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

/** The entry point every manifest must contain. */
export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA in abel30567/fermi-daemon. */
	ref: string
	/** Relative path (from the repo root) → sha256 hex of that file at `ref`. */
	files: Record<string, string>
}

const REF_RE = /^[0-9a-f]{7,40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const MAX_FILES = 64

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/**
 * A path is safe when it is relative, uses only `[A-Za-z0-9._-]` segments and
 * cannot escape the install dir (no absolute paths, `..`, empty or dot-led
 * segments). Paths are interpolated into the boot script and URLs.
 */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg))
}

/** Manifest shape check: non-empty map of safe paths → sha256, containing the entry. */
export function isValidRunnerFiles(files: unknown): files is Record<string, string> {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return false
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_FILES) return false
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return false
	return entries.every(
		([p, h]) => isSafeRunnerPath(p) && typeof h === 'string' && SHA256_RE.test(h),
	)
}

export function isValidRunnerPin(pin: unknown): pin is RunnerPin {
	if (!pin || typeof pin !== 'object') return false
	const p = pin as Partial<RunnerPin>
	return isValidRunnerRef(p.ref) && isValidRunnerFiles(p.files)
}

/**
 * Read the pin out of fleet:config. Returns null when unset or invalid (fail
 * closed): a manifest must contain box-runner.mjs and only safe paths, and when
 * both are set `runner_sha256` must agree with the manifest's entry hash.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	const ref = config.runner_ref
	if (!isValidRunnerRef(ref)) return null
	const legacy = config.runner_sha256
	const files = config.runner_files
	if (files !== undefined && files !== null) {
		if (!isValidRunnerFiles(files)) return null
		if (legacy !== undefined && legacy !== null && legacy !== files[RUNNER_ENTRY]) return null
		return { ref, files: { ...files } }
	}
	if (typeof legacy !== 'string' || !SHA256_RE.test(legacy)) return null
	return { ref, files: { [RUNNER_ENTRY]: legacy } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify every
 * hash → install into the same relative layout under `destDir`. Aborts
 * non-zero on any missing file or mismatch (callers run under
 * `set -euo pipefail`) before anything is moved into place. No fallback to a
 * baked copy — fail closed is the point. Throws on an invalid pin.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isValidRunnerPin(pin)) throw new Error('invalid runner pin')
	const dest = opts.destDir ?? '/opt/fermi'
	const staging = `${dest}/.runner-staging`
	const url = (p: string) => (opts.baseUrl ? `${opts.baseUrl}/${p}` : runnerUrl(pin.ref, p))
	const paths = Object.keys(pin.files).sort()
	const dirs = (root: string) => [
		...new Set(
			paths.filter((p) => p.includes('/')).map((p) => `${root}/${p.replace(/\/[^/]+$/, '')}`),
		),
	]
	return [
		`rm -rf '${staging}'`,
		`mkdir -p '${staging}'`,
		...dirs(staging).map((d) => `mkdir -p '${d}'`),
		// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
		// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
		// throttling; the sha256 gate still catches anything short or tampered.
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${url(p)}' -o '${staging}/${p}'`,
		),
		...paths.map((p) => `echo '${pin.files[p]}  ${staging}/${p}' | sha256sum -c - >/dev/null`),
		...dirs(dest).map((d) => `mkdir -p '${d}'`),
		...paths.map((p) => `mv '${staging}/${p}' '${dest}/${p}'`),
		`rm -rf '${staging}'`,
	].join('\n')
}
