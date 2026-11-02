/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file never sees credentials and the box fails closed
 * (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * A pin is a manifest: one ref plus a sha256 per file, so box-runner can ship
 * alongside the daemon's shared modules (`harness/`, `lib/`). A legacy pin
 * (`runner_sha256` only) is the one-file manifest `{ 'box-runner.mjs': sha }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path in the daemon repo -> sha256 hex. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA_RE = /^[0-9a-f]{64}$/
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const MAX_FILES = 64

export function isSafeRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/**
 * A manifest path must stay inside the install dir and be inert inside a
 * single-quoted shell string: relative, `/`-separated, no `.`/`..`/empty
 * segments, no leading dot, conservative charset.
 */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg))
}

/** Validate a `{path: sha256}` map; returns a normalized copy or null. */
export function parseRunnerFiles(files: unknown): Record<string, string> | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return null
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_FILES) return null
	const out: Record<string, string> = {}
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path) || typeof sha !== 'string') return null
		const hex = sha.toLowerCase()
		if (!SHA_RE.test(hex)) return null
		out[path] = hex
	}
	if (!(RUNNER_ENTRY in out)) return null
	return out
}

/**
 * Resolve the pin from fleet:config. Null when unset or invalid — callers
 * must treat both as "refuse to launch".
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isSafeRunnerRef(config.runner_ref)) return null
	const legacy =
		typeof config.runner_sha256 === 'string' && SHA_RE.test(config.runner_sha256.toLowerCase())
			? config.runner_sha256.toLowerCase()
			: null
	if (config.runner_files !== undefined && config.runner_files !== null) {
		const files = parseRunnerFiles(config.runner_files)
		if (!files) return null
		// Both fields set but disagreeing means a half-written pin: refuse.
		if (config.runner_sha256 != null && legacy !== files[RUNNER_ENTRY]) return null
		return { ref: config.runner_ref, files }
	}
	if (!legacy) return null
	return { ref: config.runner_ref, files: { [RUNNER_ENTRY]: legacy } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every file into a staging dir → verify every hash →
 * install into the same relative layout. Aborts non-zero on any missing or
 * mismatched file (callers run under `set -euo pipefail`) before anything is
 * installed. No fallback to a baked copy — fail closed is the point.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; dir?: string } = {},
): string {
	if (!isSafeRunnerRef(pin.ref)) throw new Error('invalid runner ref')
	const files = parseRunnerFiles(pin.files)
	if (!files) throw new Error('invalid runner manifest')
	const dir = opts.dir ?? '/opt/fermi'
	const stage = `${dir}/.runner-staging`
	const url = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl}/${path}` : runnerUrl(pin.ref, path)
	const paths = Object.keys(files).sort()
	const subdirs = [
		...new Set(paths.filter((p) => p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/')))),
	]
	const mkdirs = (root: string) =>
		subdirs.length ? [`mkdir -p ${subdirs.map((d) => `'${root}/${d}'`).join(' ')}`] : []
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}'`,
		...mkdirs(stage),
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${url(p)}' -o '${stage}/${p}'`,
		),
		...paths.map((p) => `echo '${files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`),
		...mkdirs(dir),
		...paths.map((p) => `mv '${stage}/${p}' '${dir}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
