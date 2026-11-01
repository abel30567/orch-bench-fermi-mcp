/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file means nothing is installed, the runner never sees
 * credentials and the box fails closed (never heartbeats; the provision-grace
 * reaper path reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * ship with the daemon's shared modules (`harness/`, `lib/`). A legacy
 * single-file pin (`runner_ref` + `runner_sha256`) is the manifest
 * `{ 'box-runner.mjs': sha256 }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'
const MAX_FILES = 64

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path (in the daemon repo) → sha256 hex. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const SHA256_RE = /^[0-9a-f]{64}$/
// Refs and paths are interpolated into a URL and a shell script, so only a
// conservative character set is accepted (no quotes, spaces or `..`).
const REF_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,99}$/
const SEGMENT_RE = /^[0-9A-Za-z_][0-9A-Za-z._-]*$/

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/** Relative, normalized, no dot-segments, no leading slash, shell-safe. */
export function isSafeRunnerPath(path: unknown): path is string {
	return (
		typeof path === 'string' &&
		path.length > 0 &&
		path.length <= 200 &&
		path.split('/').every((seg) => SEGMENT_RE.test(seg))
	)
}

/** A manifest is a non-empty map of safe paths to sha256 hex that includes box-runner.mjs. */
export function isValidRunnerFiles(files: unknown): files is Record<string, string> {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return false
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_FILES) return false
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return false
	return entries.every(
		([path, sha]) => isSafeRunnerPath(path) && typeof sha === 'string' && SHA256_RE.test(sha),
	)
}

/**
 * Resolve the pin from fleet:config. `runner_files` (a manifest) takes
 * precedence; otherwise `runner_sha256` is a legacy single-file pin. Returns
 * null when the pin is unset or invalid — callers must refuse to launch.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isValidRunnerRef(config.runner_ref)) return null
	const ref = config.runner_ref
	if (config.runner_files !== undefined && config.runner_files !== null) {
		if (!isValidRunnerFiles(config.runner_files)) return null
		return { ref, files: { ...config.runner_files } }
	}
	if (typeof config.runner_sha256 !== 'string' || !SHA256_RE.test(config.runner_sha256)) return null
	return { ref, files: { [RUNNER_ENTRY]: config.runner_sha256 } }
}

const RAW_BASE = 'https://raw.githubusercontent.com/abel30567/fermi-daemon'

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `${RAW_BASE}/${ref}/${path}`
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify every
 * hash → install into the same relative layout under `destDir`. Aborts
 * non-zero on any missing file or mismatch (callers run under
 * `set -euo pipefail`), leaving nothing installed. No fallback to a baked
 * copy — fail closed is the point.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isValidRunnerRef(pin.ref)) throw new Error('invalid runner pin: bad ref')
	if (!isValidRunnerFiles(pin.files)) throw new Error('invalid runner pin: bad files manifest')
	const baseUrl = opts.baseUrl ?? `${RAW_BASE}/${pin.ref}`
	const destDir = opts.destDir ?? '/opt/fermi'
	const stage = `${destDir}/.runner-staging`
	const abort = `|| { rm -rf '${stage}'; exit 1; }`
	// Entry point last, so it lands only after its modules are in place.
	const paths = Object.keys(pin.files).sort((a, b) =>
		a === RUNNER_ENTRY ? 1 : b === RUNNER_ENTRY ? -1 : a < b ? -1 : a > b ? 1 : 0,
	)
	const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
	const lines = [`rm -rf '${stage}'`, `mkdir -p '${stage}'`]
	for (const p of paths) {
		const dir = dirOf(p)
		if (dir) lines.push(`mkdir -p '${stage}/${dir}'`)
		// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
		// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
		// throttling; the sha256 gate still catches anything short or tampered.
		lines.push(
			`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${baseUrl}/${p}' -o '${stage}/${p}' ${abort}`,
		)
	}
	lines.push(
		`(cd '${stage}' && sha256sum -c - >/dev/null <<'FERMI_RUNNER_PIN'`,
		...paths.map((p) => `${pin.files[p]}  ${p}`),
		'FERMI_RUNNER_PIN',
		`) ${abort}`,
	)
	for (const p of paths) {
		const dir = dirOf(p)
		if (dir) lines.push(`mkdir -p '${destDir}/${dir}'`)
		lines.push(`mv -f '${stage}/${p}' '${destDir}/${p}'`)
	}
	lines.push(`rm -rf '${stage}'`)
	return lines.join('\n')
}
