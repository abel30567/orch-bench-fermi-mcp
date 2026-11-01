/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file never sees credentials and the box fails closed
 * (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * import shared daemon modules (`harness/`, `lib/`). A legacy single-file pin
 * (`runner_sha256` only) is the manifest `{ 'box-runner.mjs': sha256 }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'
const MAX_FILES = 64

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path in the daemon repo → sha256 hex. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const SHA256_RE = /^[0-9a-f]{64}$/
// Each segment starts with an alphanumeric or `_`: rules out `.`, `..`, hidden
// files and anything that needs shell quoting.
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isSha256(v: unknown): v is string {
	return typeof v === 'string' && SHA256_RE.test(v)
}

export function isSafeRunnerPath(p: unknown): p is string {
	return typeof p === 'string' && p.length <= 200 && p.split('/').every((s) => SEGMENT_RE.test(s))
}

function isSafeRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/** A manifest is valid when it pins box-runner.mjs and every path/hash is safe. */
export function isValidRunnerFiles(files: unknown): files is Record<string, string> {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return false
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_FILES) return false
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return false
	return entries.every(([p, sha]) => isSafeRunnerPath(p) && isSha256(sha))
}

/** Resolve the pin from fleet:config; null when unset or invalid (launch refuses). */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	const ref = config.runner_ref
	if (!isSafeRef(ref)) return null
	if (config.runner_files !== undefined && config.runner_files !== null) {
		if (!isValidRunnerFiles(config.runner_files)) return null
		return { ref, files: { ...config.runner_files } }
	}
	if (!isSha256(config.runner_sha256)) return null
	return { ref, files: { [RUNNER_ENTRY]: config.runner_sha256 } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every file into a staging dir → verify every hash →
 * install into the same relative layout under destDir. Aborts non-zero on any
 * missing or mismatched file (callers run under `set -euo pipefail`) before
 * anything is installed. No fallback to a baked copy — fail closed is the point.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isSafeRef(pin.ref)) throw new Error('invalid runner ref')
	if (!isValidRunnerFiles(pin.files)) throw new Error('invalid runner manifest')
	const destDir = opts.destDir ?? '/opt/fermi'
	const stage = `${destDir}/.runner-stage`
	const url = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl}/${path}` : runnerUrl(pin.ref, path)
	const paths = Object.keys(pin.files).sort()
	const dirs = (root: string) =>
		[...new Set(paths.map((p) => p.split('/').slice(0, -1).join('/')).filter(Boolean))].map(
			(d) => `'${root}/${d}'`,
		)
	const lines = [`rm -rf '${stage}'`, `mkdir -p '${stage}' ${dirs(stage).join(' ')}`.trimEnd()]
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	for (const p of paths) {
		lines.push(
			`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${url(p)}' -o '${stage}/${p}'`,
		)
	}
	for (const p of paths) {
		lines.push(`echo '${pin.files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`)
	}
	const destDirs = dirs(destDir)
	if (destDirs.length) lines.push(`mkdir -p ${destDirs.join(' ')}`)
	for (const p of paths) lines.push(`mv '${stage}/${p}' '${destDir}/${p}'`)
	lines.push(`rm -rf '${stage}'`)
	return lines.join('\n')
}
