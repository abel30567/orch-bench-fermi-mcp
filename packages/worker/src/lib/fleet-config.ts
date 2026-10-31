import { RUNNER_ENTRY, isRunnerManifest, runnerUrl } from './runner-pin.ts'

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
	/** Manifest pin (path → sha256); null means the legacy single-file pin. */
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

export interface PinRunnerResult {
	status: number
	body: Record<string, unknown>
}

/**
 * POST /admin/fleet/pin-runner: fetch each file at `ref`, hash it, and store the
 * pin. With `files`, every hash must match what the ref serves, so a wrong
 * manifest fails here rather than bricking every boot. Without it, the legacy
 * single-file pin hashes box-runner.mjs.
 */
export async function pinRunner(
	env: Env,
	input: { ref?: unknown; files?: unknown },
): Promise<PinRunnerResult> {
	const { ref, files } = input
	if (typeof ref !== 'string' || !/^[0-9a-f]{7,40}$/.test(ref))
		return { status: 400, body: { ok: false, error: 'ref must be a commit sha' } }
	if (files !== undefined && !isRunnerManifest(files)) {
		return {
			status: 400,
			body: { ok: false, error: `files must be a path → sha256 map including ${RUNNER_ENTRY}` },
		}
	}

	const hashes: Array<[string, string]> = []
	let bytes = 0
	for (const path of files ? Object.keys(files) : [RUNNER_ENTRY]) {
		const res = await fetch(runnerUrl(ref, path)).catch(() => null)
		if (!res) return { status: 502, body: { ok: false, error: 'fetch_failed', path } }
		if (!res.ok) return { status: 502, body: { ok: false, error: `fetch_${res.status}`, path } }
		const content = await res.arrayBuffer()
		const digest = await crypto.subtle.digest('SHA-256', content)
		const sha256 = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
		if (files && files[path] !== sha256) {
			return { status: 409, body: { ok: false, error: 'hash_mismatch', path, sha256 } }
		}
		hashes.push([path, sha256])
		bytes += content.byteLength
	}

	const pinned = Object.fromEntries(hashes)
	const raw = await env.FERMI_KV.get('fleet:config')
	let stored: Record<string, unknown> = {}
	try {
		stored = raw ? JSON.parse(raw) : {}
	} catch {}
	const sha256 = pinned[RUNNER_ENTRY]
	// A legacy pin must clear any earlier manifest: it would otherwise win over
	// the new ref, with hashes from the old one.
	await env.FERMI_KV.put(
		'fleet:config',
		JSON.stringify({
			...stored,
			runner_ref: ref,
			runner_sha256: sha256,
			runner_files: files ? pinned : null,
		}),
	)
	return {
		status: 200,
		body: { ok: true, ref, sha256, bytes, ...(files ? { files: pinned } : {}) },
	}
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
