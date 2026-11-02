/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file never sees credentials and the box fails closed
 * (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ref, files: {path: sha256}}` so box-runner can ship
 * with the daemon's shared modules (`harness/`, `lib/`). A legacy single-file
 * pin (`runner_sha256` only) is the manifest `{'box-runner.mjs': sha256}`.
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

const SHA256_RE = /^[0-9a-f]{64}$/
// Refs and paths are interpolated into single-quoted shell and a URL: keep
// them to a conservative charset so neither can break out.
const REF_RE = /^[A-Za-z0-9._-]{1,64}$/
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const MAX_FILES = 64

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/** Relative, no `.`/`..`/empty segments, no absolute paths, shell-safe charset. */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg))
}

/** Manifest error message, or null when `files` is a valid manifest. */
export function runnerFilesError(files: unknown): string | null {
	if (!files || typeof files !== 'object' || Array.isArray(files))
		return 'files must be an object of path -> sha256'
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length > MAX_FILES) return `files must list at most ${MAX_FILES} paths`
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path)) return `unsafe path: ${JSON.stringify(path)}`
		if (typeof sha !== 'string' || !SHA256_RE.test(sha))
			return `sha256 for ${path} must be 64 lowercase hex chars`
	}
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return `files must include ${RUNNER_ENTRY}`
	return null
}

/**
 * The pin stored in fleet:config, or null when unset or invalid (launch must
 * refuse either way). `runner_files` wins; a legacy pin is `runner_sha256` alone.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: string | null
	runner_sha256?: string | null
	runner_files?: Record<string, string> | null
}): RunnerPin | null {
	const { runner_ref: ref, runner_sha256: sha, runner_files: files } = config
	if (!isValidRunnerRef(ref)) return null
	if (files !== undefined && files !== null) {
		if (runnerFilesError(files) !== null) return null
		// A stale legacy hash that disagrees with the manifest is a corrupt pin.
		if (sha && sha !== files[RUNNER_ENTRY]) return null
		return { ref, files: { ...files } }
	}
	if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
	return { ref, files: { [RUNNER_ENTRY]: sha } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify every
 * hash → install into `dir` with the same relative layout. Aborts non-zero on
 * any missing or mismatched file (callers run under `set -euo pipefail`),
 * leaving nothing installed. No fallback to a baked copy — fail closed is the
 * point. Throws on an invalid manifest so a bad pin never reaches user-data.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; dir?: string } = {},
): string {
	if (!isValidRunnerRef(pin.ref)) throw new Error('invalid runner ref')
	const err = runnerFilesError(pin.files)
	if (err) throw new Error(`invalid runner manifest: ${err}`)
	const dir = opts.dir ?? '/opt/fermi'
	const stage = `${dir}/.runner-staging`
	const url = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl}/${path}` : runnerUrl(pin.ref, path)
	// Entry point first; sorted for a deterministic script.
	const paths = Object.keys(pin.files).sort((a, b) =>
		a === RUNNER_ENTRY ? -1 : b === RUNNER_ENTRY ? 1 : a < b ? -1 : a > b ? 1 : 0,
	)
	const subdirs = (root: string) => {
		const ds = [...new Set(paths.map((p) => p.split('/').slice(0, -1).join('/')).filter(Boolean))]
		return ds.length ? [`mkdir -p ${ds.map((d) => `'${root}/${d}'`).join(' ')}`] : []
	}
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}'`,
		...subdirs(stage),
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${url(p)}' -o '${stage}/${p}'`,
		),
		...paths.map((p) => `echo '${pin.files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`),
		...subdirs(dir),
		...paths.map((p) => `mv '${stage}/${p}' '${dir}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
