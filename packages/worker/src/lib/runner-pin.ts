/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched runner file's sha256 BEFORE the box token is materialized — a
 * tampered, missing or unpinned file never sees credentials and the box fails
 * closed (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

// One user-data line per fetch and per hash, and EC2 caps user-data at 16 KB.
const MAX_RUNNER_FILES = 24
const MAX_RUNNER_PATH = 100

const REF_RE = /^[0-9a-f]{7,40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
// Paths land in root shell user-data, so the charset is what keeps them inert.
const PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
// `-` means stdin to sha256sum, and `__proto__` is lost when a manifest is copied.
const UNSAFE_SEGMENT_RE = /^(?:\.{1,2}|-.*|__proto__)$/

export interface RunnerPin {
	/** Commit SHA in abel30567/fermi-daemon. */
	ref: string
	/** Repo-relative path → sha256 hex at that ref. Always has box-runner.mjs. */
	files: Record<string, string>
}

export function isValidRunnerRef(ref: unknown): ref is string {
	return typeof ref === 'string' && REF_RE.test(ref)
}

function isSafeRunnerPath(path: string): boolean {
	return (
		path.length <= MAX_RUNNER_PATH &&
		PATH_RE.test(path) &&
		path.split('/').every((segment) => !UNSAFE_SEGMENT_RE.test(segment))
	)
}

export function isValidRunnerFiles(files: unknown): files is Record<string, string> {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return false
	const entries = Object.entries(files)
	return (
		entries.length <= MAX_RUNNER_FILES &&
		Object.hasOwn(files, RUNNER_ENTRY) &&
		entries.every(
			([path, sha256]) =>
				isSafeRunnerPath(path) && typeof sha256 === 'string' && SHA256_RE.test(sha256),
		)
	)
}

/**
 * The pin stored in fleet:config, or null when unset or invalid. A present but
 * invalid `runner_files` is never downgraded to the single-file pin next to it.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	const { runner_ref: ref, runner_sha256: sha256, runner_files: manifest } = config
	if (!isValidRunnerRef(ref)) return null
	const files = manifest ?? (sha256 ? { [RUNNER_ENTRY]: sha256 } : null)
	return isValidRunnerFiles(files) ? { ref, files } : null
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch all → verify all → install all, into the same relative
 * layout under /opt/fermi. Aborts non-zero on any missing or mismatched file
 * (callers run under `set -euo pipefail`) with nothing installed: a staging
 * directory keeps a good file from landing next to a bad one. No fallback to a
 * baked copy — fail closed is the point.
 */
export function runnerFetchScript(pin: RunnerPin): string {
	if (!isValidRunnerRef(pin.ref) || !isValidRunnerFiles(pin.files)) {
		throw new Error('invalid runner pin')
	}
	const entries = Object.entries(pin.files)
	return [
		'RUNNER_STAGE=$(mktemp -d /opt/fermi/.runner-stage.XXXXXX)',
		`trap 'rm -rf "$RUNNER_STAGE"' EXIT`,
		// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
		// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
		// throttling; the sha256 gate still catches anything short or tampered.
		'fetch_runner_file() {',
		'  mkdir -p "$(dirname "$RUNNER_STAGE/$2")"',
		'  curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors "$1" -o "$RUNNER_STAGE/$2"',
		'}',
		'install_runner_file() {',
		'  mkdir -p "$(dirname "/opt/fermi/$1")"',
		'  mv -f "$RUNNER_STAGE/$1" "/opt/fermi/$1"',
		'}',
		...entries.map(([path]) => `fetch_runner_file '${runnerUrl(pin.ref, path)}' '${path}'`),
		// --strict: without it a line sha256sum can't parse is skipped, not failed.
		`(cd "$RUNNER_STAGE" && sha256sum --strict -c - >/dev/null) <<'RUNNER_PIN'`,
		...entries.map(([path, sha256]) => `${sha256}  ${path}`),
		'RUNNER_PIN',
		...entries.map(([path]) => `install_runner_file '${path}'`),
	].join('\n')
}
