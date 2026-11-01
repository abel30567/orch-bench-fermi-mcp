/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched runner file's sha256 BEFORE the box token is materialized — a
 * tampered, missing or unpinned file never sees credentials and the box fails
 * closed (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * import shared daemon modules (`harness/`, `lib/`). A legacy single-file pin
 * (`runner_ref` + `runner_sha256`) is the manifest `{ 'box-runner.mjs': sha }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'
export const MAX_RUNNER_FILES = 64

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path (from the repo root) → sha256 hex. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const SHA256_RE = /^[0-9a-f]{64}$/
const REF_RE = /^[A-Za-z0-9._-]{1,64}$/
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

export function isSha256(v: unknown): v is string {
	return typeof v === 'string' && SHA256_RE.test(v)
}

/**
 * A manifest path must be relative, made only of shell- and URL-safe
 * segments, with no `.`/`..`, empty segments or hidden-file tricks.
 */
export function isSafeRunnerPath(p: unknown): p is string {
	if (typeof p !== 'string' || p.length === 0 || p.length > 200) return false
	return p.split('/').every((seg) => SEGMENT_RE.test(seg) && seg !== '.' && seg !== '..')
}

/** Validated copy of a `{ path: sha256 }` manifest, or null when malformed. */
export function validateRunnerFiles(files: unknown): Record<string, string> | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return null
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_RUNNER_FILES) return null
	const out: Record<string, string> = {}
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path) || !isSha256(sha)) return null
		out[path] = sha
	}
	if (!(RUNNER_ENTRY in out)) return null
	return out
}

/**
 * Pin from fleet:config, or null when unset or invalid. `runner_files` (the
 * manifest) wins; when both are set, `runner_sha256` must agree with the
 * manifest's box-runner.mjs entry.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	const ref = config.runner_ref
	if (typeof ref !== 'string' || !REF_RE.test(ref)) return null
	const sha = config.runner_sha256
	if (config.runner_files !== undefined && config.runner_files !== null) {
		const files = validateRunnerFiles(config.runner_files)
		if (!files) return null
		if (sha !== undefined && sha !== null && sha !== files[RUNNER_ENTRY]) return null
		return { ref, files }
	}
	if (!isSha256(sha)) return null
	return { ref, files: { [RUNNER_ENTRY]: sha } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every file into a staging dir → verify every hash →
 * install into the same relative layout under `destDir`. Aborts non-zero on
 * any missing or mismatched file (callers run under `set -euo pipefail`),
 * leaving nothing installed. No fallback to a baked copy — fail closed is the
 * point. Throws on an invalid manifest.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	const valid = runnerPinFromConfig({ runner_ref: pin.ref, runner_files: pin.files })
	if (!valid) throw new Error('invalid runner pin manifest')
	const destDir = (opts.destDir ?? '/opt/fermi').replace(/\/+$/, '')
	if (/['\n]/.test(destDir) || (opts.baseUrl && /['\n]/.test(opts.baseUrl)))
		throw new Error('unsafe runner fetch option')
	const stage = `${destDir}/.runner-staging`
	const url = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl.replace(/\/+$/, '')}/${path}` : runnerUrl(valid.ref, path)
	const paths = Object.keys(valid.files).sort()
	const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
	const lines: string[] = [`rm -rf '${stage}'`, `mkdir -p '${stage}'`]
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	for (const p of paths) {
		const d = dirOf(p)
		if (d) lines.push(`mkdir -p '${stage}/${d}'`)
		lines.push(
			`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${url(p)}' -o '${stage}/${p}'`,
		)
	}
	// Verify ALL files before installing ANY of them.
	lines.push(`sha256sum -c - >/dev/null <<'FERMI_RUNNER_PIN'`)
	for (const p of paths) lines.push(`${valid.files[p]}  ${stage}/${p}`)
	lines.push('FERMI_RUNNER_PIN')
	for (const p of paths) {
		const d = dirOf(p)
		if (d) lines.push(`mkdir -p '${destDir}/${d}'`)
		lines.push(`mv '${stage}/${p}' '${destDir}/${p}'`)
	}
	lines.push(`rm -rf '${stage}'`)
	return lines.join('\n')
}
