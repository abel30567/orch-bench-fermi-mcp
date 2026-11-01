/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file means the runner never sees credentials and the box
 * fails closed (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest: box-runner.mjs plus any shared daemon modules it
 * imports (`harness/`, `lib/`), each fetched into the same relative layout.
 * A legacy pin (`runner_sha256` only) is the one-file manifest.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Repo-relative path → sha256 hex at that ref. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_RE = /^[0-9a-f]{64}$/
// Leading char excludes '.', so `.`, `..` and dotfiles are all refused.
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
export const MAX_RUNNER_FILES = 64

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/**
 * Relative, normalized, shell- and URL-safe: no absolute paths, no `.`/`..`
 * segments, no empty segments, no quoting or glob characters.
 */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 256) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg))
}

/** Validates a manifest map; returns null when anything about it is unsafe. */
export function validRunnerFiles(files: unknown): Record<string, string> | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return null
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_RUNNER_FILES) return null
	const out: Record<string, string> = {}
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path) || typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
		out[path] = sha
	}
	if (!(RUNNER_ENTRY in out)) return null
	// A file and a directory of the same name can't both be laid out.
	for (const path of Object.keys(out)) {
		if (Object.keys(out).some((other) => other.startsWith(`${path}/`))) return null
	}
	return out
}

/**
 * Reads the pin from fleet:config. Null when unset or invalid — the caller
 * refuses to launch. `runner_files` (manifest) wins over the legacy
 * `runner_sha256`; when both are present they must agree on box-runner.mjs.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isValidRunnerRef(config.runner_ref)) return null
	const ref = config.runner_ref
	const legacy = config.runner_sha256
	if (config.runner_files !== undefined && config.runner_files !== null) {
		const files = validRunnerFiles(config.runner_files)
		if (!files) return null
		if (legacy !== undefined && legacy !== null && legacy !== files[RUNNER_ENTRY]) return null
		return { ref, files }
	}
	if (typeof legacy !== 'string' || !SHA256_RE.test(legacy)) return null
	return { ref, files: { [RUNNER_ENTRY]: legacy } }
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
 * only then install them all. Aborts non-zero on any missing file or mismatch
 * (callers run under `set -euo pipefail`), leaving nothing installed. No
 * fallback to a baked copy — fail closed is the point.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isValidRunnerRef(pin.ref)) throw new Error('invalid runner ref')
	const files = validRunnerFiles(pin.files)
	if (!files) throw new Error('invalid runner manifest')
	const base = opts.baseUrl ?? runnerUrl(pin.ref, '').replace(/\/$/, '')
	const dest = opts.destDir ?? '/opt/fermi'
	const stage = `${dest}.new`
	const paths = Object.keys(files).sort()
	const dirs = [...new Set(paths.map(dirOf).filter((d): d is string => d !== null))].sort()
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}'${dirs.map((d) => ` '${stage}/${d}'`).join('')}`,
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${base}/${p}' -o '${stage}/${p}'`,
		),
		...paths.map((p) => `echo '${files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`),
		`mkdir -p '${dest}'${dirs.map((d) => ` '${dest}/${d}'`).join('')}`,
		...paths.map((p) => `mv '${stage}/${p}' '${dest}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
