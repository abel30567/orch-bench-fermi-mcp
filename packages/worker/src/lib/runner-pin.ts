/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file means the runner never sees credentials and the box
 * fails closed (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * use shared daemon modules (`harness/`, `lib/`). A legacy single-file pin
 * (`runner_sha256` only) is the manifest `{ 'box-runner.mjs': sha256 }`.
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

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const MAX_FILES = 64

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref) && !ref.includes('..')
}

/** Relative, no traversal, no absolute paths, shell-safe characters only. */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg) && seg !== '.' && seg !== '..')
}

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
	const p = pin as { ref?: unknown; files?: unknown }
	return isValidRunnerRef(p.ref) && isValidRunnerFiles(p.files)
}

/**
 * Pin from fleet:config. `runner_files` (manifest) wins; otherwise the legacy
 * `runner_sha256` pins box-runner.mjs alone. Null when unset or invalid.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: string | null
	runner_sha256?: string | null
	runner_files?: Record<string, string> | null
}): RunnerPin | null {
	const ref = config.runner_ref
	if (!isValidRunnerRef(ref)) return null
	if (config.runner_files != null) {
		return isValidRunnerFiles(config.runner_files)
			? { ref, files: { ...config.runner_files } }
			: null
	}
	const sha = config.runner_sha256
	if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
	return { ref, files: { [RUNNER_ENTRY]: sha } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every file into a staging dir → verify each sha256 →
 * install into the same relative layout under destDir. Aborts non-zero on any
 * missing or mismatched file (callers run under `set -euo pipefail`) before
 * anything is installed. No fallback to a baked copy — fail closed is the point.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isValidRunnerPin(pin)) throw new Error('invalid runner pin manifest')
	const base = opts.baseUrl ?? runnerUrl(pin.ref, '').replace(/\/$/, '')
	const dest = (opts.destDir ?? '/opt/fermi').replace(/\/$/, '')
	const stage = `${dest}/.runner-staging`
	const paths = Object.keys(pin.files).sort()
	const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
	const lines = [`rm -rf '${stage}'`, `mkdir -p '${stage}'`]
	for (const p of paths) {
		const dir = dirOf(p)
		if (dir) lines.push(`mkdir -p '${stage}/${dir}'`)
		// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
		// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
		// throttling; the sha256 gate still catches anything short or tampered.
		lines.push(
			`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${base}/${p}' -o '${stage}/${p}'`,
			`echo '${pin.files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`,
		)
	}
	// Every file verified: only now install any of them.
	for (const p of paths) {
		const dir = dirOf(p)
		if (dir) lines.push(`mkdir -p '${dest}/${dir}'`)
		lines.push(`mv '${stage}/${p}' '${dest}/${p}'`)
	}
	lines.push(`rm -rf '${stage}'`)
	return lines.join('\n')
}
