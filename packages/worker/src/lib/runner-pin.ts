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

/** The runner entry point; every manifest must pin it. */
export const RUNNER_ENTRY = 'box-runner.mjs'

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path (from the fermi-daemon repo root) -> sha256 hex at that ref. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_RE = /^[0-9a-f]{64}$/i
// One path segment: no leading dot (so no `.`/`..`/hidden files), and a
// charset that is inert inside single-quoted shell strings and URLs.
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
const MAX_FILES = 64

export function isRunnerRef(v: unknown): v is string {
	return typeof v === 'string' && REF_RE.test(v)
}

export function isSafeRunnerPath(p: unknown): p is string {
	if (typeof p !== 'string' || p.length === 0 || p.length > 256) return false
	return p.split('/').every((seg) => SEGMENT_RE.test(seg))
}

/** A manifest is a non-empty `{ path: sha256 }` map with safe paths that pins box-runner.mjs. */
export function isRunnerManifest(files: unknown): files is Record<string, string> {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return false
	const entries = Object.entries(files)
	if (entries.length === 0 || entries.length > MAX_FILES) return false
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return false
	return entries.every(
		([path, sha]) => isSafeRunnerPath(path) && typeof sha === 'string' && SHA256_RE.test(sha),
	)
}

/**
 * Read the pin from fleet:config. `runner_files` (manifest) wins over the
 * legacy `runner_sha256`; when both are set they must agree on box-runner.mjs.
 * Returns null when the pin is unset or invalid — callers refuse to launch.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: string | null
	runner_sha256?: string | null
	runner_files?: Record<string, string> | null
}): RunnerPin | null {
	const { runner_ref: ref, runner_sha256: sha, runner_files: files } = config
	if (!isRunnerRef(ref)) return null
	if (files != null) {
		if (!isRunnerManifest(files)) return null
		if (sha != null && sha.toLowerCase() !== files[RUNNER_ENTRY].toLowerCase()) return null
		return { ref, files: { ...files } }
	}
	if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
	return { ref, files: { [RUNNER_ENTRY]: sha } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

function parentDir(path: string): string | null {
	const i = path.lastIndexOf('/')
	return i === -1 ? null : path.slice(0, i)
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify every
 * hash → install into the same relative layout under `dir`. Aborts non-zero on
 * any missing or mismatched file (callers run under `set -euo pipefail`),
 * leaving nothing installed. No fallback to a baked copy — fail closed is the
 * point. Throws on an invalid pin so a bad manifest never reaches user-data.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; dir?: string } = {},
): string {
	if (!isRunnerRef(pin.ref)) throw new Error('invalid runner pin: bad ref')
	if (!isRunnerManifest(pin.files)) throw new Error('invalid runner pin: bad files manifest')
	const dir = opts.dir ?? '/opt/fermi'
	const stage = `${dir}.pin-staging`
	const url = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl}/${path}` : runnerUrl(pin.ref, path)
	const paths = Object.keys(pin.files).sort()
	const subdirs = (root: string) =>
		[...new Set(paths.map(parentDir).filter((d): d is string => d !== null))]
			.sort()
			.map((d) => `mkdir -p '${root}/${d}'`)
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}' '${dir}'`,
		...subdirs(stage),
		// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
		// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
		// throttling; the sha256 gate still catches anything short or tampered.
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${url(p)}' -o '${stage}/${p}'`,
		),
		// Verify ALL files before installing ANY: a partial install never runs.
		...paths.map((p) => `echo '${pin.files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`),
		...subdirs(dir),
		...paths.map((p) => `mv '${stage}/${p}' '${dir}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
