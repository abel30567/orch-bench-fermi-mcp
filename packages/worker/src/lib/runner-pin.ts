/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file means the runner never sees credentials and the box
 * fails closed (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * import shared daemon modules (`harness/`, `lib/`). A legacy single-file pin
 * (`runner_ref` + `runner_sha256`) is the manifest `{ 'box-runner.mjs': sha }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path → sha256 hex at that ref. Always contains box-runner.mjs. */
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
 * A safe path is relative, has no `.`/`..` segments and only shell-inert
 * characters, so it can be interpolated into the boot script and can never
 * escape the install root.
 */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg) && seg !== '.' && seg !== '..')
}

/** Validate a `{ path: sha256 }` manifest; null when malformed or missing box-runner.mjs. */
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
	return out
}

/** Read the pin from fleet:config; null when unset or invalid (fail closed). */
export function runnerPinFromConfig(config: {
	runner_ref?: string | null
	runner_sha256?: string | null
	runner_files?: unknown
}): RunnerPin | null {
	if (!isValidRunnerRef(config.runner_ref)) return null
	if (config.runner_files !== undefined && config.runner_files !== null) {
		const files = validateRunnerFiles(config.runner_files)
		if (!files) return null
		// runner_sha256 mirrors the entry hash; a disagreement means a corrupt pin.
		if (config.runner_sha256 && config.runner_sha256 !== files[RUNNER_ENTRY]) return null
		return { ref: config.runner_ref, files }
	}
	if (typeof config.runner_sha256 !== 'string' || !SHA256_RE.test(config.runner_sha256)) return null
	return { ref: config.runner_ref, files: { [RUNNER_ENTRY]: config.runner_sha256 } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every file into a staging dir → verify every hash →
 * install into the same relative layout under `root`. Aborts non-zero on any
 * missing file or mismatch (callers run under `set -euo pipefail`), before
 * anything is installed. No fallback to a baked copy — fail closed is the point.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; root?: string } = {},
): string {
	if (!isValidRunnerRef(pin.ref)) throw new Error('invalid runner ref')
	const files = validateRunnerFiles(pin.files)
	if (!files) throw new Error('invalid runner manifest')
	const base = opts.baseUrl ?? runnerUrl(pin.ref, '').replace(/\/$/, '')
	const root = opts.root ?? '/opt/fermi'
	const stage = `${root}/.runner-new`
	const paths = Object.keys(files).sort()
	const lines = [`rm -rf '${stage}'`, `mkdir -p '${stage}'`]
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	for (const p of paths) {
		lines.push(
			`mkdir -p "$(dirname '${stage}/${p}')"`,
			`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${base}/${p}' -o '${stage}/${p}'`,
		)
	}
	lines.push(`(cd '${stage}' && sha256sum -c - >/dev/null) <<'FERMI_RUNNER_SUMS'`)
	for (const p of paths) lines.push(`${files[p]}  ${p}`)
	lines.push('FERMI_RUNNER_SUMS')
	for (const p of paths) {
		lines.push(`mkdir -p "$(dirname '${root}/${p}')"`, `mv '${stage}/${p}' '${root}/${p}'`)
	}
	lines.push(`rm -rf '${stage}'`)
	return lines.join('\n')
}
