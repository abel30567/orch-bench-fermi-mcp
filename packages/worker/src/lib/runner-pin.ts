/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file never sees credentials and the box fails closed
 * (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * The pin is a manifest `{ ref, files: { path: sha256 } }` so box-runner can
 * ship with the daemon's shared modules (`harness/`, `lib/`). A legacy pin
 * (`runner_sha256` only) is the one-file manifest `{ 'box-runner.mjs': sha }`.
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

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA_RE = /^[0-9a-f]{64}$/
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_FILES = 64

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref) && !ref.includes('..')
}

/**
 * Relative path made of plain segments: no leading `/`, no `.`/`..` or dotfiles, no
 * empty segments, no characters that need shell quoting (paths land in user-data).
 */
export function isSafeRunnerPath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
	return path.split('/').every((s) => SEGMENT_RE.test(s))
}

export function isValidRunnerFiles(files: unknown): files is Record<string, string> {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return false
	const entries = Object.entries(files as Record<string, unknown>)
	if (entries.length === 0 || entries.length > MAX_FILES) return false
	if (!Object.prototype.hasOwnProperty.call(files, RUNNER_ENTRY)) return false
	return entries.every(
		([p, sha]) => isSafeRunnerPath(p) && typeof sha === 'string' && SHA_RE.test(sha),
	)
}

function isValidPin(pin: RunnerPin): boolean {
	return isValidRunnerRef(pin.ref) && isValidRunnerFiles(pin.files)
}

/**
 * Resolve the pin from fleet:config. `runner_files` (manifest) wins when set;
 * otherwise `runner_sha256` is the legacy single-file pin. Null when unset or
 * invalid — the caller refuses to launch.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	const ref = config.runner_ref
	if (!isValidRunnerRef(ref)) return null
	if (config.runner_files !== undefined && config.runner_files !== null) {
		if (!isValidRunnerFiles(config.runner_files)) return null
		return { ref, files: { ...config.runner_files } }
	}
	const sha = config.runner_sha256
	if (typeof sha !== 'string' || !SHA_RE.test(sha)) return null
	return { ref, files: { [RUNNER_ENTRY]: sha } }
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch every manifest file into a staging dir (same relative
 * layout) → verify all hashes → install. Aborts non-zero on any missing or
 * mismatched file (callers run under `set -euo pipefail`), leaving nothing
 * installed. No fallback to a baked copy — fail closed is the point.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; dest?: string } = {},
): string {
	if (!isValidPin(pin)) throw new Error('invalid runner pin manifest')
	const base = opts.baseUrl ?? runnerUrl(pin.ref, '').replace(/\/$/, '')
	const dest = opts.dest ?? '/opt/fermi'
	const stage = `${dest}.runner-stage`
	const paths = Object.keys(pin.files).sort()
	// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
	// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
	// throttling; the sha256 gate still catches anything short or tampered.
	return [
		`rm -rf '${stage}'`,
		`mkdir -p '${stage}' '${dest}'`,
		...paths.map(
			(p) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors --create-dirs '${base}/${p}' -o '${stage}/${p}'`,
		),
		`(cd '${stage}' && sha256sum -c - >/dev/null) <<'FERMI_RUNNER_SUMS'`,
		...paths.map((p) => `${pin.files[p]}  ${p}`),
		'FERMI_RUNNER_SUMS',
		...paths.flatMap((p) => {
			const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
			return [...(dir ? [`mkdir -p '${dest}/${dir}'`] : []), `mv -f '${stage}/${p}' '${dest}/${p}'`]
		}),
		`rm -rf '${stage}'`,
	].join('\n')
}
