import { RUNNER_ENTRY, isSafeRunnerPath, isSha256, runnerUrl } from './runner-pin.ts'

export interface FleetConfig {
	region: string
	monthly_budget_usd: number
	max_concurrent: number
	instance_type: string
	/** Per-launch `instance_type` overrides must come from this list (#43). */
	allowed_instance_types: string[]
	claude_model: string
	default_env: string | null
	mcp_base_url: string | null
	/** Supply-chain pin for the box-runner boot download (#34); launch refuses when unset. */
	runner_ref: string | null
	runner_sha256: string | null
	/** Multi-file manifest `{ path: sha256 }` incl. box-runner.mjs; null = legacy single-file pin. */
	runner_files: Record<string, string> | null
	default_ttl_seconds: number
	max_ttl_seconds: number
	heartbeat_stale_ms: number
	provision_grace_ms: number
}

const DEFAULTS: FleetConfig = {
	region: 'us-east-1',
	monthly_budget_usd: 50,
	max_concurrent: 5,
	instance_type: 't3.small',
	allowed_instance_types: ['t3.small', 't3.medium', 't3.large'],
	claude_model: 'claude-opus-4-6[1m]',
	default_env: null,
	mcp_base_url: null,
	runner_ref: null,
	runner_sha256: null,
	runner_files: null,
	default_ttl_seconds: 3600,
	max_ttl_seconds: 4 * 3600,
	heartbeat_stale_ms: 10 * 60_000,
	provision_grace_ms: 15 * 60_000,
}

// On-demand USD/hour, us-east-1 Linux. Used for budget accrual estimates;
// the authoritative number is the AWS bill (fleetctl report reconciles).
export const HOURLY_RATES: Record<string, number> = {
	't3.micro': 0.0104,
	't3.small': 0.0208,
	't3.medium': 0.0416,
	't3.large': 0.0832,
}

export async function getFleetConfig(env: Env): Promise<FleetConfig> {
	const raw = await env.FERMI_KV.get('fleet:config')
	if (!raw) return { ...DEFAULTS }
	try {
		return { ...DEFAULTS, ...JSON.parse(raw) }
	} catch {
		return { ...DEFAULTS }
	}
}

/** Resolve a launch's instance type: explicit must be allowlisted, else the fleet default. */
export function resolveInstanceType(
	config: FleetConfig,
	requested: string | undefined,
): { ok: true; instance_type: string } | { ok: false; error: string; allowed: string[] } {
	if (requested === undefined) return { ok: true, instance_type: config.instance_type }
	if (!config.allowed_instance_types.includes(requested)) {
		return { ok: false, error: 'instance_type_not_allowed', allowed: config.allowed_instance_types }
	}
	return { ok: true, instance_type: requested }
}

/**
 * Operator-editable fleet:config fields (POST /admin/fleet/config, #43). The
 * runner pin is deliberately excluded — it has its own fetch+hash endpoint.
 */
export type FleetConfigPatch = Partial<
	Pick<
		FleetConfig,
		| 'instance_type'
		| 'allowed_instance_types'
		| 'max_concurrent'
		| 'monthly_budget_usd'
		| 'default_ttl_seconds'
		| 'claude_model'
	>
>

export function validateFleetConfigPatch(
	current: FleetConfig,
	body: unknown,
): { ok: true; config: FleetConfig; patch: FleetConfigPatch } | { ok: false; error: string } {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return { ok: false, error: 'body must be an object' }
	}
	const b = body as Record<string, unknown>
	const patch: FleetConfigPatch = {}
	const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0
	for (const key of Object.keys(b)) {
		const v = b[key]
		switch (key) {
			case 'instance_type':
			case 'claude_model':
				if (typeof v !== 'string' || v.length === 0 || v.length > 64)
					return { ok: false, error: `${key} must be a non-empty string` }
				patch[key] = v
				break
			case 'allowed_instance_types':
				if (!Array.isArray(v) || v.length === 0 || !v.every((t) => typeof t === 'string' && t))
					return { ok: false, error: 'allowed_instance_types must be a non-empty string array' }
				patch.allowed_instance_types = v as string[]
				break
			case 'max_concurrent':
			case 'default_ttl_seconds':
				if (!isPosInt(v)) return { ok: false, error: `${key} must be a positive integer` }
				patch[key] = v
				break
			case 'monthly_budget_usd':
				if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
					return { ok: false, error: 'monthly_budget_usd must be a non-negative number' }
				patch.monthly_budget_usd = v
				break
			default:
				return { ok: false, error: `${key} is not an editable field` }
		}
	}
	if (Object.keys(patch).length === 0) return { ok: false, error: 'no editable fields supplied' }
	const config: FleetConfig = { ...current, ...patch }
	if (!config.allowed_instance_types.includes(config.instance_type)) {
		return { ok: false, error: 'instance_type must be one of allowed_instance_types' }
	}
	if (config.default_ttl_seconds > config.max_ttl_seconds) {
		return {
			ok: false,
			error: `default_ttl_seconds exceeds max_ttl_seconds (${config.max_ttl_seconds})`,
		}
	}
	return { ok: true, config, patch }
}

export async function updateFleetConfig(
	env: Env,
	body: unknown,
): Promise<{ ok: true; config: FleetConfig } | { ok: false; error: string }> {
	const current = await getFleetConfig(env)
	const verdict = validateFleetConfigPatch(current, body)
	if (!verdict.ok) return verdict
	// Merge onto the raw stored object so unknown/forward fields survive.
	const raw = await env.FERMI_KV.get('fleet:config')
	let stored: Record<string, unknown> = {}
	try {
		stored = raw ? JSON.parse(raw) : {}
	} catch {}
	await env.FERMI_KV.put('fleet:config', JSON.stringify({ ...stored, ...verdict.patch }))
	return { ok: true, config: verdict.config }
}

/**
 * POST /admin/fleet/pin-runner (#34). Fetches every file at `ref`, hashes it
 * here, and stores the manifest. `files` is either a list of paths (hashed as
 * served) or a `{ path: sha256 }` manifest (each served file must match).
 * Omitting `files` pins box-runner.mjs alone, as before.
 */
export async function pinRunner(
	env: Env,
	body: { ref?: unknown; files?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
	const bad = (error: string) => ({ status: 400, body: { ok: false, error } })
	const ref = body.ref
	if (typeof ref !== 'string' || !/^[0-9a-f]{7,40}$/.test(ref))
		return bad('ref must be a commit sha')

	let expected: Record<string, string | null>
	if (body.files === undefined || body.files === null) {
		expected = { [RUNNER_ENTRY]: null }
	} else if (Array.isArray(body.files)) {
		if (!body.files.every(isSafeRunnerPath))
			return bad('files: every path must be a safe relative path')
		expected = Object.fromEntries(body.files.map((p) => [p, null]))
	} else if (typeof body.files === 'object') {
		const entries = Object.entries(body.files as Record<string, unknown>)
		if (!entries.every(([p, sha]) => isSafeRunnerPath(p) && isSha256(sha)))
			return bad('files must map safe relative paths to sha256 hex')
		expected = Object.fromEntries(entries) as Record<string, string>
	} else {
		return bad('files must be a path list or a { path: sha256 } manifest')
	}
	const paths = Object.keys(expected).sort()
	if (!(RUNNER_ENTRY in expected)) return bad(`files must include ${RUNNER_ENTRY}`)
	if (paths.length > 64) return bad('files: at most 64 entries')

	const files: Record<string, string> = {}
	let bytes = 0
	for (const path of paths) {
		const res = await fetch(runnerUrl(ref, path))
		if (!res.ok) return { status: 502, body: { ok: false, error: `fetch_${res.status}`, path } }
		const buf = await res.arrayBuffer()
		const digest = await crypto.subtle.digest('SHA-256', buf)
		const sha256 = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
		const want = expected[path]
		if (want && want !== sha256)
			return {
				status: 409,
				body: { ok: false, error: 'sha256_mismatch', path, expected: want, sha256 },
			}
		files[path] = sha256
		bytes += buf.byteLength
	}

	const raw = await env.FERMI_KV.get('fleet:config')
	let stored: Record<string, unknown> = {}
	try {
		stored = raw ? JSON.parse(raw) : {}
	} catch {}
	// A single-file pin clears any previous manifest so the legacy path applies.
	const runner_files = paths.length === 1 ? null : files
	await env.FERMI_KV.put(
		'fleet:config',
		JSON.stringify({
			...stored,
			runner_ref: ref,
			runner_sha256: files[RUNNER_ENTRY],
			runner_files,
		}),
	)
	return { status: 200, body: { ok: true, ref, sha256: files[RUNNER_ENTRY], files, bytes } }
}

export function hourlyRate(instanceType: string): number {
	return HOURLY_RATES[instanceType] ?? HOURLY_RATES['t3.small']
}

/** Estimated cost of a run: wall-clock hours x instance rate. */
export function accruedCostUsd(startedAt: number, endedAt: number, instanceType: string): number {
	const hours = Math.max(endedAt - startedAt, 0) / 3_600_000
	return Math.round(hours * hourlyRate(instanceType) * 10_000) / 10_000
}

export function monthStart(now: number): number {
	const d = new Date(now)
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

/** Sum of estimated spend for agents created this calendar month (UTC). */
export async function monthSpendUsd(db: D1Database, now: number): Promise<number> {
	const row = await db
		.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cloud_agents WHERE created_at >= ?1')
		.bind(monthStart(now))
		.first<{ total: number }>()
	return row?.total ?? 0
}
