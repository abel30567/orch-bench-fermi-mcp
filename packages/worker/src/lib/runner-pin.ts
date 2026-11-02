/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file means the runner never sees credentials and the box
 * fails closed (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * A pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can ship
 * alongside the daemon's shared modules (`harness/`, `lib/`). A legacy pin
 * (`runner_ref` + `runner_sha256`, no `runner_files`) is the one-file manifest
 * `{ 'box-runner.mjs': runner_sha256 }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'
export const RUNNER_MAX_FILES = 64

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path in the daemon repo → sha256 hex. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,128}$/
const SHA256_RE = /^[0-9a-f]{64}$/
// Each segment starts with a word character: no absolute paths, no `.`/`..`,
// no hidden files, nothing a shell or URL would reinterpret.
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

export function isSafeRunnerPath(path: string): boolean {
	return path.length > 0 && path.length <= 256 && path.split('/').every((s) => SEGMENT_RE.test(s))
}

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/** Why a manifest is invalid, or null when it is valid. */
export function runnerManifestError(files: unknown): string | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return 'files must be an object'
	const entries = Object.entries(files)
	if (entries.length > RUNNER_MAX_FILES)
		return `files must list at most ${RUNNER_MAX_FILES} entries`
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return `files must contain ${RUNNER_ENTRY}`
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path)) return `unsafe path: ${path}`
		if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return `invalid sha256 for ${path}`
	}
	return null
}

/** The pin stored in fleet:config, or null when it is unset or invalid (fail closed). */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isValidRunnerRef(config.runner_ref)) return null
	const ref = config.runner_ref
	if (config.runner_files !== undefined && config.runner_files !== null) {
		if (runnerManifestError(config.runner_files) !== null) return null
		const files = { ...(config.runner_files as Record<string, string>) }
		// A legacy hash that disagrees with the manifest is a corrupted pin.
		if (config.runner_sha256 != null && config.runner_sha256 !== files[RUNNER_ENTRY]) return null
		return { ref, files }
	}
	if (typeof config.runner_sha256 !== 'string' || !SHA256_RE.test(config.runner_sha256)) return null
	return { ref, files: { [RUNNER_ENTRY]: config.runner_sha256 } }
}

export function runnerUrl(ref: string, path = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify every
 * hash → install into the same relative layout under `destDir`. Aborts non-zero
 * on any missing or mismatched file (callers run under `set -euo pipefail`)
 * before anything is installed. No fallback to a baked copy — fail closed is
 * the point. Throws on an invalid manifest so no fragment is ever emitted for it.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isValidRunnerRef(pin.ref)) throw new Error(`invalid runner ref: ${pin.ref}`)
	const manifestError = runnerManifestError(pin.files)
	if (manifestError) throw new Error(`invalid runner manifest: ${manifestError}`)
	const destDir = opts.destDir ?? '/opt/fermi'
	const stage = `${destDir}/.runner-stage`
	const url = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl}/${path}` : runnerUrl(pin.ref, path)
	const paths = Object.keys(pin.files).sort()
	const dirs = [
		...new Set(paths.filter((p) => p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/')))),
	].sort()
	const checklist = paths.map((p) => `'${pin.files[p]}  ${p}'`).join(' ')
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}'${dirs.map((d) => ` '${stage}/${d}'`).join('')}`,
		// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
		// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
		// throttling; the sha256 gate still catches anything short or tampered.
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${url(p)}' -o '${stage}/${p}'`,
		),
		// Every hash is checked before anything moves out of staging.
		`printf '%s\\n' ${checklist} | (cd '${stage}' && sha256sum -c - >/dev/null)`,
		...(dirs.length ? [`mkdir -p${dirs.map((d) => ` '${destDir}/${d}'`).join('')}`] : []),
		...paths.map((p) => `mv '${stage}/${p}' '${destDir}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
