/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file means the runner never sees credentials and the
 * box fails closed (never heartbeats; the provision-grace reaper reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * load shared daemon modules (`harness/`, `lib/`). A legacy single-file pin
 * (`runner_ref` + `runner_sha256`) is the manifest `{ 'box-runner.mjs': sha }`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'
export const MAX_RUNNER_FILES = 64

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path in the daemon repo → sha256 hex. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA_RE = /^[0-9a-fA-F]{64}$/
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref) && !ref.includes('..')
}

export function isValidSha256(sha: unknown): sha is string {
	return typeof sha === 'string' && SHA_RE.test(sha)
}

/**
 * A manifest path is relative, made of plain segments (no `.`/`..`, no empty
 * segments, no leading `/`), and shell-quote safe. Anything else could escape
 * the install directory or the single-quoted fragment.
 */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg) && seg !== '.' && seg !== '..')
}

/** Validate a `{ path: sha256 }` map. Returns a normalized copy, or null when invalid. */
export function parseRunnerFiles(value: unknown): Record<string, string> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const entries = Object.entries(value as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_RUNNER_FILES) return null
	const files: Record<string, string> = {}
	for (const [path, sha] of entries) {
		if (!isSafeRunnerPath(path) || !isValidSha256(sha)) return null
		files[path] = sha.toLowerCase()
	}
	if (!(RUNNER_ENTRY in files)) return null
	return files
}

/**
 * The effective pin from fleet:config. `runner_files` (manifest) wins when
 * present; otherwise the legacy `runner_sha256` pins box-runner.mjs alone.
 * Null when unset or invalid — the caller must refuse to launch.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isValidRunnerRef(config.runner_ref)) return null
	if (config.runner_files !== undefined && config.runner_files !== null) {
		const files = parseRunnerFiles(config.runner_files)
		return files ? { ref: config.runner_ref, files } : null
	}
	if (!isValidSha256(config.runner_sha256)) return null
	return { ref: config.runner_ref, files: { [RUNNER_ENTRY]: config.runner_sha256.toLowerCase() } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify every
 * sha256 → install into the same relative layout. Aborts non-zero on any
 * missing or mismatched file (callers run under `set -euo pipefail`) before
 * anything is installed. No fallback to a baked copy — fail closed is the
 * point. Throws on an invalid manifest so a bad pin never renders a script.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; dir?: string } = {},
): string {
	if (!isValidRunnerRef(pin?.ref)) throw new Error('invalid runner pin: bad ref')
	const files = parseRunnerFiles(pin.files)
	if (!files) throw new Error('invalid runner pin: bad files manifest')
	const baseUrl = (opts.baseUrl ?? runnerUrl(pin.ref, '')).replace(/\/+$/, '')
	const dir = (opts.dir ?? '/opt/fermi').replace(/\/+$/, '')
	const stage = `${dir}/.runner-stage`
	const paths = Object.keys(files).sort((a, b) =>
		a === RUNNER_ENTRY ? -1 : b === RUNNER_ENTRY ? 1 : a < b ? -1 : 1,
	)
	const parents = (root: string) => [
		...new Set(
			paths.filter((p) => p.includes('/')).map((p) => `'${root}/${p.replace(/\/[^/]+$/, '')}'`),
		),
	]
	const stageParents = parents(stage)
	const installParents = parents(dir)
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}'${stageParents.length ? ` ${stageParents.join(' ')}` : ''}`,
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${baseUrl}/${p}' -o '${stage}/${p}'`,
		),
		...paths.map((p) => `echo '${files[p]}  ${stage}/${p}' | sha256sum -c - >/dev/null`),
		...(installParents.length ? [`mkdir -p ${installParents.join(' ')}`] : []),
		...paths.map((p) => `mv '${stage}/${p}' '${dir}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}
