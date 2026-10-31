/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file never sees credentials and the box fails closed
 * (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

/** The entry point: every pin covers it, a legacy pin covers nothing else. */
export const RUNNER_ENTRY = 'box-runner.mjs'

// Each file adds a few hundred bytes of user-data, which EC2 caps at 16 KB.
const MAX_RUNNER_FILES = 32
const MAX_RUNNER_PATH = 128

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Repo-relative path → sha256 hex at that ref. Always includes box-runner.mjs. */
	files: Record<string, string>
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

function isSafeRef(ref: unknown): ref is string {
	return typeof ref === 'string' && /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(ref)
}

function isSha256(hash: unknown): hash is string {
	return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)
}

/** Paths land in single-quoted shell words and under the install dir, so allow only plain segments. */
function isSafePath(path: string): boolean {
	return (
		path.length <= MAX_RUNNER_PATH &&
		path
			.split('/')
			.every(
				(segment) =>
					/^[0-9A-Za-z._][0-9A-Za-z._-]*$/.test(segment) && segment !== '.' && segment !== '..',
			)
	)
}

export function isRunnerManifest(files: unknown): files is Record<string, string> {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return false
	const entries = Object.entries(files)
	const paths = entries.map(([path]) => path)
	return (
		entries.length <= MAX_RUNNER_FILES &&
		paths.includes(RUNNER_ENTRY) &&
		entries.every(([path, hash]) => isSafePath(path) && isSha256(hash)) &&
		// `lib` and `lib/x.mjs` cannot both exist on disk.
		!paths.some((path) => paths.some((other) => other.startsWith(`${path}/`)))
	)
}

/**
 * The pin stored in fleet:config, or null when it is unset or invalid. A stored
 * manifest is never bypassed: an invalid one does not fall back to the
 * single-file fields, so a corrupt pin refuses the launch.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: unknown
	runner_sha256?: unknown
	runner_files?: unknown
}): RunnerPin | null {
	const { runner_ref: ref, runner_sha256: sha256, runner_files: files } = config
	if (!isSafeRef(ref)) return null
	if (files !== undefined && files !== null) return isRunnerManifest(files) ? { ref, files } : null
	return isSha256(sha256) ? { ref, files: { [RUNNER_ENTRY]: sha256 } } : null
}

/**
 * Bash fragment: fetch all → verify all → install all. Aborts non-zero on any
 * missing or mismatched file (callers run under `set -euo pipefail`), leaving
 * nothing installed: files wait in a sibling staging dir until every hash has
 * passed, and the entry point moves last. No fallback to a baked copy — fail
 * closed is the point.
 */
export function runnerFetchScript(pin: RunnerPin, opts: { dir?: string } = {}): string {
	if (!isSafeRef(pin.ref)) throw new Error('invalid runner ref')
	if (!isRunnerManifest(pin.files)) throw new Error('invalid runner manifest')
	const dir = opts.dir ?? '/opt/fermi'
	const staging = `${dir}.new`
	const paths = Object.keys(pin.files)
		.filter((path) => path !== RUNNER_ENTRY)
		.sort()
	paths.push(RUNNER_ENTRY)
	const subdirs = [
		...new Set(paths.filter((p) => p.includes('/')).map((p) => p.replace(/\/[^/]+$/, ''))),
	]
	return [
		`rm -rf '${staging}'`,
		`mkdir -p '${staging}'`,
		...subdirs.map((sub) => `mkdir -p '${staging}/${sub}'`),
		// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
		// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
		// throttling; the sha256 gate still catches anything short or tampered.
		...paths.map(
			(path) =>
				`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${runnerUrl(pin.ref, path)}' -o '${staging}/${path}'`,
		),
		...paths.map(
			(path) => `echo '${pin.files[path]}  ${staging}/${path}' | sha256sum -c - >/dev/null`,
		),
		...subdirs.map((sub) => `mkdir -p '${dir}/${sub}'`),
		...paths.map((path) => `mv '${staging}/${path}' '${dir}/${path}'`),
		`rm -rf '${staging}'`,
	].join('\n')
}
