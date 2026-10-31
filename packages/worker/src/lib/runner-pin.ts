/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched runner file's sha256 BEFORE the box token is materialized — a
 * tampered, missing or unpinned file means the runner never sees credentials
 * and the box fails closed (never heartbeats; the provision-grace reaper path
 * reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * import the daemon's shared modules (`harness/`, `lib/`). A legacy pin
 * (`runner_ref` + `runner_sha256` only) is the one-file manifest
 * `{ 'box-runner.mjs': runner_sha256 }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path in the daemon repo → sha256 hex at that ref. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const MAX_FILES = 64

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/**
 * A relative path that cannot escape the install dir or break out of the
 * single-quoted shell words it is interpolated into: no leading `/`, no `.`
 * or `..` segments, no hidden segments, only `[A-Za-z0-9._-]`.
 */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg))
}

/** Validated copy of a `{ path: sha256 }` manifest, or null when malformed. */
export function validateRunnerFiles(files: unknown): Record<string, string> | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return null
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_FILES) return null
	const out: Record<string, string> = {}
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path) || typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
		out[path] = sha
	}
	if (!(RUNNER_ENTRY in out)) return null
	// A file cannot also be a directory of another entry (`lib` and `lib/x.mjs`).
	const paths = Object.keys(out)
	if (paths.some((p) => paths.some((q) => q.startsWith(`${p}/`)))) return null
	return out
}

/**
 * Read the pin out of fleet:config. Null when unset or invalid — callers must
 * treat both as "do not boot". When both `runner_files` and the legacy
 * `runner_sha256` are present they must agree on box-runner.mjs.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isValidRunnerRef(config.runner_ref)) return null
	const legacy = config.runner_sha256
	if (
		legacy !== null &&
		legacy !== undefined &&
		(typeof legacy !== 'string' || !SHA256_RE.test(legacy))
	)
		return null
	if (config.runner_files !== null && config.runner_files !== undefined) {
		const files = validateRunnerFiles(config.runner_files)
		if (!files) return null
		if (typeof legacy === 'string' && files[RUNNER_ENTRY] !== legacy) return null
		return { ref: config.runner_ref, files }
	}
	if (typeof legacy !== 'string') return null
	return { ref: config.runner_ref, files: { [RUNNER_ENTRY]: legacy } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify each
 * hash → install into the same relative layout under `dir`. Aborts non-zero on
 * any fetch failure or mismatch (callers run under `set -euo pipefail`),
 * leaving nothing installed. No fallback to a baked copy — fail closed is the
 * point. Throws on an invalid pin so a bad manifest never reaches user-data.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; dir?: string; retries?: number } = {},
): string {
	if (!isValidRunnerRef(pin?.ref)) throw new Error('invalid runner pin: bad ref')
	const files = validateRunnerFiles(pin.files)
	if (!files) throw new Error('invalid runner pin: bad files manifest')
	const dir = opts.dir ?? '/opt/fermi'
	const stage = `${dir}/.runner.new`
	const url = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl}/${path}` : runnerUrl(pin.ref, path)
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	const retries = opts.retries ?? 4
	const retry = retries > 0 ? ` --retry ${retries} --retry-delay 3 --retry-all-errors` : ''
	const paths = Object.keys(files).sort()
	const parents = [
		...new Set(paths.map((p) => p.split('/').slice(0, -1).join('/')).filter(Boolean)),
	]
	const lines = [`rm -rf '${stage}'`, `mkdir -p '${stage}'`]
	for (const parent of parents) lines.push(`mkdir -p '${stage}/${parent}'`)
	for (const path of paths) {
		lines.push(`curl -fsSL${retry} '${url(path)}' -o '${stage}/${path}'`)
		lines.push(`echo '${files[path]}  ${stage}/${path}' | sha256sum -c - >/dev/null`)
	}
	// Only reached when every file verified.
	for (const parent of parents) lines.push(`mkdir -p '${dir}/${parent}'`)
	for (const path of paths) lines.push(`mv '${stage}/${path}' '${dir}/${path}'`)
	lines.push(`rm -rf '${stage}'`)
	return lines.join('\n')
}
