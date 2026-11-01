/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched runner file's sha256 BEFORE the box token is materialized — a
 * tampered, missing or unpinned file means the runner never sees credentials
 * and the box fails closed (never heartbeats; the provision-grace reaper path
 * reclaims it).
 *
 * The pin is a manifest: one ref plus a sha256 per file, so box-runner can
 * import shared daemon modules (`harness/`, `lib/`). A legacy pin
 * (`runner_ref` + `runner_sha256`) is the one-file manifest `box-runner.mjs`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'
const MAX_FILES = 64

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path (from the repo root at `ref`) -> sha256 hex. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_RE = /^[0-9a-f]{64}$/
// Each segment starts with an alphanumeric/_/- so `.`, `..` and hidden names are refused.
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

export function isSafeRunnerPath(path: string): boolean {
	if (path.length === 0 || path.length > 256) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg))
}

/** Validate a `{path: sha256}` manifest. Returns the manifest or an error string. */
export function validateRunnerFiles(
	files: unknown,
): { ok: true; files: Record<string, string> } | { ok: false; error: string } {
	if (!files || typeof files !== 'object' || Array.isArray(files))
		return { ok: false, error: 'files must be an object of path -> sha256' }
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_FILES)
		return { ok: false, error: `files must list 1..${MAX_FILES} entries` }
	const out: Record<string, string> = {}
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path)) return { ok: false, error: `unsafe path: ${path}` }
		if (typeof sha !== 'string' || !SHA256_RE.test(sha))
			return { ok: false, error: `sha256 for ${path} must be 64 lowercase hex chars` }
		out[path] = sha
	}
	if (!(RUNNER_ENTRY in out)) return { ok: false, error: `files must include ${RUNNER_ENTRY}` }
	return { ok: true, files: out }
}

/**
 * Read the pin from fleet:config. `runner_files` (manifest) wins over the
 * legacy `runner_sha256`. Null when unset or invalid — launch must refuse.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	const ref = config.runner_ref
	if (typeof ref !== 'string' || !REF_RE.test(ref)) return null
	if (config.runner_files !== undefined && config.runner_files !== null) {
		const v = validateRunnerFiles(config.runner_files)
		return v.ok ? { ref, files: v.files } : null
	}
	const sha = config.runner_sha256
	if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
	return { ref, files: { [RUNNER_ENTRY]: sha } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify every
 * hash → only then install into the same relative layout. Aborts non-zero on
 * any missing or mismatched file (callers run under `set -euo pipefail`),
 * leaving nothing installed. No fallback to a baked copy — fail closed is the
 * point. Throws on an invalid manifest.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; dir?: string } = {},
): string {
	if (!REF_RE.test(pin.ref)) throw new Error('invalid runner ref')
	const v = validateRunnerFiles(pin.files)
	if (!v.ok) throw new Error(`invalid runner manifest: ${v.error}`)
	const base = opts.baseUrl ?? runnerUrl(pin.ref, '').replace(/\/$/, '')
	const dir = opts.dir ?? '/opt/fermi'
	const stage = `${dir}/.runner-new`
	const paths = Object.keys(v.files).sort()
	const subdirs = (root: string) => [
		...new Set(paths.filter((p) => p.includes('/')).map((p) => `'${root}/${dirname(p)}'`)),
	]
	const stageDirs = subdirs(stage)
	const installDirs = subdirs(dir)
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}'${stageDirs.length ? ` ${stageDirs.join(' ')}` : ''}`,
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${base}/${p}' -o '${stage}/${p}'`,
		),
		...paths.map((p) => `echo '${v.files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`),
		...(installDirs.length ? [`mkdir -p ${installDirs.join(' ')}`] : []),
		...paths.map((p) => `mv '${stage}/${p}' '${dir}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}

function dirname(path: string): string {
	return path.slice(0, path.lastIndexOf('/'))
}
