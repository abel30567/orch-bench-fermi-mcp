/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies the
 * sha256 of every fetched runner file BEFORE the box token is materialized — a
 * tampered, missing or unpinned file means the runner never sees credentials
 * and the box fails closed (never heartbeats; the provision-grace reaper path
 * reclaims it).
 *
 * The pin is a manifest `{ref, files: {path: sha256}}` so box-runner can ship
 * with shared daemon modules (`harness/`, `lib/`). A legacy single-file pin
 * (`runner_ref` + `runner_sha256`) is the manifest `{'box-runner.mjs': sha}`.
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Repo-relative path → sha256 hex. Always contains `box-runner.mjs`. */
	files: Record<string, string>
}

/** The runner entrypoint every manifest must pin. */
export const RUNNER_ENTRY = 'box-runner.mjs'

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const MAX_FILES = 64

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

export function isSafeRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/**
 * Relative path made of plain segments: no leading `/`, no `.`/`..`, no
 * hidden or empty segments, no shell metacharacters (paths are interpolated
 * into single-quoted bash).
 */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((seg) => SEGMENT_RE.test(seg))
}

/** Validated copy of a `{path: sha256}` manifest, or null when malformed. */
export function parseRunnerFiles(files: unknown): Record<string, string> | null {
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

/**
 * Resolve the pin from fleet:config. Null when unset or invalid — callers
 * must refuse to launch. `runner_files` (manifest) wins over the legacy
 * `runner_sha256`; when both are set they must agree on box-runner.mjs.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	if (!isSafeRef(config.runner_ref)) return null
	const sha = config.runner_sha256
	if (config.runner_files !== undefined && config.runner_files !== null) {
		const files = parseRunnerFiles(config.runner_files)
		if (!files) return null
		if (sha !== undefined && sha !== null && sha !== files[RUNNER_ENTRY]) return null
		return { ref: config.runner_ref, files }
	}
	if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
	return { ref: config.runner_ref, files: { [RUNNER_ENTRY]: sha } }
}

/**
 * Bash fragment: fetch every file into a staging dir → verify every hash →
 * install. Aborts non-zero on any missing file or mismatch (callers run under
 * `set -euo pipefail`), leaving nothing installed. No fallback to a baked
 * copy — fail closed is the point. Throws on an invalid manifest.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!isSafeRef(pin.ref)) throw new Error('runner pin: invalid ref')
	const files = parseRunnerFiles(pin.files)
	if (!files) throw new Error('runner pin: invalid manifest')
	const destDir = opts.destDir ?? '/opt/fermi'
	const stage = `${destDir}.runner-new`
	const url = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl}/${path}` : runnerUrl(pin.ref, path)
	// Entry last so box-runner.mjs never lands before its modules.
	const paths = Object.keys(files).sort((a, b) =>
		a === RUNNER_ENTRY ? 1 : b === RUNNER_ENTRY ? -1 : a.localeCompare(b),
	)
	const dirs = [...new Set(paths.filter((p) => p.includes('/')).map((p) => dirname(p)))]
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
		"sha256sum -c - >/dev/null <<'RUNNER_PIN'",
		...paths.map((p) => `${files[p]}  ${stage}/${p}`),
		'RUNNER_PIN',
		...(dirs.length ? [`mkdir -p${dirs.map((d) => ` '${destDir}/${d}'`).join('')}`] : []),
		...paths.map((p) => `mv '${stage}/${p}' '${destDir}/${p}'`),
		`rm -rf '${stage}'`,
	].join('\n')
}

function dirname(path: string): string {
	return path.slice(0, path.lastIndexOf('/'))
}
