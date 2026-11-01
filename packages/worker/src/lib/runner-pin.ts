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
	/** Commit SHA in abel30567/fermi-daemon. */
	ref: string
	/** Relative path (from the repo root) → sha256 hex. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const REF_RE = /^[0-9a-f]{7,40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/
const MAX_FILES = 64

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

/**
 * A manifest path must stay inside the install dir and be shell-safe: relative,
 * `/`-separated segments of `[A-Za-z0-9._-]`, no `.`/`..`/empty segments.
 */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((seg) => seg !== '.' && seg !== '..' && SEGMENT_RE.test(seg))
}

/** Validate a `{ path: sha256 }` manifest; returns an error string or null when valid. */
export function runnerManifestError(files: unknown): string | null {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return 'files must be an object'
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length > MAX_FILES) return `files may list at most ${MAX_FILES} paths`
	if (!entries.some(([p]) => p === RUNNER_ENTRY)) return `files must include ${RUNNER_ENTRY}`
	for (const [p, sha] of entries) {
		if (!isSafeRunnerPath(p)) return `unsafe path: ${JSON.stringify(p)}`
		if (typeof sha !== 'string' || !SHA256_RE.test(sha))
			return `sha256 for ${p} must be 64 lowercase hex chars`
	}
	return null
}

function pinError(pin: RunnerPin): string | null {
	if (!isValidRunnerRef(pin?.ref)) return 'ref must be a commit sha'
	return runnerManifestError(pin.files)
}

/**
 * Resolve the pin from fleet:config. `runner_files` (manifest) wins when set;
 * otherwise the legacy `runner_sha256` pins box-runner.mjs alone. Null when the
 * pin is unset or invalid — launch must refuse.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	const ref = config.runner_ref
	if (!isValidRunnerRef(ref)) return null
	let files: Record<string, string>
	if (config.runner_files !== undefined && config.runner_files !== null) {
		if (runnerManifestError(config.runner_files)) return null
		files = { ...(config.runner_files as Record<string, string>) }
	} else {
		const sha = config.runner_sha256
		if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return null
		files = { [RUNNER_ENTRY]: sha }
	}
	return { ref, files }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every manifest file into a staging dir → verify every
 * hash → install into the same relative layout under `destDir`. Aborts non-zero
 * on any missing or mismatched file (callers run under `set -euo pipefail`),
 * leaving nothing installed. No fallback to a baked copy — fail closed is the
 * point. Throws on an invalid manifest.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string; retries?: number } = {},
): string {
	const err = pinError(pin)
	if (err) throw new Error(`invalid runner pin: ${err}`)
	const destDir = opts.destDir ?? '/opt/fermi'
	const retries = opts.retries ?? 4
	for (const v of [opts.baseUrl, destDir]) {
		if (v !== undefined && /['\n\\]/.test(v)) throw new Error('invalid runner fetch option')
	}
	if (!Number.isInteger(retries) || retries < 0) throw new Error('invalid runner fetch option')
	const url = (p: string) => (opts.baseUrl ? `${opts.baseUrl}/${p}` : runnerUrl(pin.ref, p))
	// Deterministic order, entry point first.
	const paths = Object.keys(pin.files).sort((a, b) =>
		a === RUNNER_ENTRY ? -1 : b === RUNNER_ENTRY ? 1 : a < b ? -1 : a > b ? 1 : 0,
	)
	const dirs = (base: string) =>
		[...new Set(paths.filter((p) => p.includes('/')).map((p) => p.replace(/\/[^/]+$/, '')))].map(
			(d) => `mkdir -p "${base}/${d}"`,
		)
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	const retry = retries > 0 ? ` --retry ${retries} --retry-delay 3 --retry-all-errors` : ''
	return [
		`mkdir -p '${destDir}'`,
		`runner_stage="$(mktemp -d '${destDir}/.runner-stage.XXXXXX')"`,
		...dirs('$runner_stage'),
		...paths.map((p) => `curl -fsSL${retry} '${url(p)}' -o "$runner_stage/${p}"`),
		`(cd "$runner_stage" && sha256sum -c --strict - >/dev/null) <<'FERMI_RUNNER_SUMS'`,
		...paths.map((p) => `${pin.files[p]}  ${p}`),
		'FERMI_RUNNER_SUMS',
		...dirs(destDir),
		...paths.map((p) => `mv "$runner_stage/${p}" '${destDir}/${p}'`),
		`rm -rf "$runner_stage"`,
	].join('\n')
}
