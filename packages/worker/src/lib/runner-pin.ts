/**
 * Supply-chain pin for the box-runner boot download (#34). The provisioner
 * refuses to launch without a pin, and the generated user-data verifies every
 * fetched file's sha256 BEFORE the box token is materialized — a tampered,
 * missing or unpinned file never sees credentials and the box fails closed
 * (never heartbeats; the provision-grace reaper path reclaims it).
 *
 * Leaf module: no imports, safe for both workerd and plain node (test harness).
 */

export const RUNNER_ENTRY = 'box-runner.mjs'

/**
 * Every file costs roughly 450 bytes of user-data, which EC2 caps at 16 KB.
 * Also bounds the subrequests made while pinning.
 */
export const MAX_RUNNER_FILES = 32

export interface RunnerPin {
	/** Commit SHA (or immutable tag) in abel30567/fermi-daemon. */
	ref: string
	/** Relative path → sha256 hex at that ref. Always contains box-runner.mjs. */
	files: Record<string, string>
}

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const SHA256 = /^[0-9a-f]{64}$/

// Paths and refs are spliced into a root-run shell script, so this is an
// allowlist: no absolute paths, traversal, dotfiles or shell metacharacters.
function isSafeRunnerPath(path: string): boolean {
	return path.split('/').every((segment) => SAFE_SEGMENT.test(segment))
}

/** A well-formed `{path: sha256}` map that the boot script can materialize. */
export function isRunnerManifest(files: unknown): files is Record<string, string> {
	if (!files || typeof files !== 'object' || Array.isArray(files)) return false
	const entries = Object.entries(files)
	if (entries.length > MAX_RUNNER_FILES) return false
	if (!Object.hasOwn(files, RUNNER_ENTRY)) return false
	const paths = entries.map(([path]) => path)
	return (
		entries.every(
			([path, sha256]) =>
				isSafeRunnerPath(path) && typeof sha256 === 'string' && SHA256.test(sha256),
		) &&
		// `lib` and `lib/a.mjs` cannot both exist on disk: such a pin bricks every boot.
		!paths.some((path) => paths.some((other) => other.startsWith(`${path}/`)))
	)
}

/**
 * The effective pin, or null when unset or invalid. `runner_files` wins over
 * `runner_sha256`; a corrupt manifest never falls back to the single hash, which
 * would boot a box without verifying the rest of the files.
 */
export function runnerPinFromConfig(config: {
	runner_ref?: string | null
	runner_sha256?: string | null
	runner_files?: unknown
}): RunnerPin | null {
	const ref = config.runner_ref
	if (typeof ref !== 'string' || !SAFE_REF.test(ref)) return null
	const files = config.runner_files ?? { [RUNNER_ENTRY]: config.runner_sha256 }
	return isRunnerManifest(files) ? { ref, files } : null
}

export function runnerUrl(ref: string, path: string = RUNNER_ENTRY): string {
	return `https://raw.githubusercontent.com/abel30567/fermi-daemon/${ref}/${path}`
}

/**
 * Bash fragment: fetch all → verify all → install all. Files are staged outside
 * the install layout, so any failure aborts non-zero (callers run under
 * `set -euo pipefail`) leaving nothing installed. No fallback to a baked copy —
 * fail closed is the point.
 */
export function runnerFetchScript(
	pin: RunnerPin,
	opts: { baseUrl?: string; destDir?: string } = {},
): string {
	if (!SAFE_REF.test(pin.ref) || !isRunnerManifest(pin.files)) {
		throw new Error('invalid runner pin')
	}
	const destDir = opts.destDir ?? '/opt/fermi'
	const stageDir = `${destDir}/.pin-staging`
	const urlFor = (path: string) =>
		opts.baseUrl ? `${opts.baseUrl}/${path}` : runnerUrl(pin.ref, path)
	const paths = Object.keys(pin.files)
	const dirs = [...new Set(paths.map((path) => path.slice(0, path.lastIndexOf('/') + 1)))]
	return [
		`rm -rf '${stageDir}'`,
		...dirs.map((dir) => `mkdir -p '${stageDir}/${dir}'`),
		// --retry: large fleets boot in bursts and GitHub's raw CDN throttles them
		// (2 of 100 boxes died to this on 2026-09-07). Retries cover transient
		// throttling; the sha256 gate still catches anything short or tampered.
		...paths.flatMap((path) => [
			`curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors '${urlFor(path)}' -o '${stageDir}/${path}'`,
			`echo '${pin.files[path]}  ${stageDir}/${path}' | sha256sum -c - >/dev/null`,
		]),
		...dirs.map((dir) => `mkdir -p '${destDir}/${dir}'`),
		...paths.map((path) => `mv '${stageDir}/${path}' '${destDir}/${path}'`),
		`rm -rf '${stageDir}'`,
	].join('\n')
}
