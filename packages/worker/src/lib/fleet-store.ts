export interface BoxRow {
	box_id: string
	provider: 'aws' | 'cloudflare' | 'private'
	status: 'provisioning' | 'online' | 'offline' | 'destroyed'
	instance_ref: string | null
	mcp_url: string | null
	oauth_client_id: string | null
	region: string | null
	snapshot_ref: string | null
	last_heartbeat_at: number | null
	created_at: number
	destroyed_at: number | null
	meta: string
}

export interface CloudAgentRow {
	id: string
	box_id: string | null
	task_id: string | null
	queue: string
	status: 'launching' | 'running' | 'waiting_human' | 'done' | 'failed' | 'destroyed'
	route: 'claude' | 'codex' | 'grok'
	prompt: string
	proof_contract: string
	budget_usd: number | null
	ttl_seconds: number | null
	cost_usd: number
	inference_usd: number
	exit_reason: string | null
	artifacts_prefix: string | null
	created_at: number
	started_at: number | null
	ended_at: number | null
	/** Per-launch EC2 size (#43); null = fleet default at provision time. */
	instance_type: string | null
	/** Liveness (#42): last `working:` progress note, and runner restarts seen. */
	last_working_event_at: number | null
	restart_count: number
}

/** Agent record plus its box's heartbeat, so clients check liveness without parsing events (#42). */
export type CloudAgentView = CloudAgentRow & { last_heartbeat_at: number | null }

export const FLEET_ROUTES: CloudAgentRow['route'][] = ['claude', 'codex', 'grok']

export interface RouteHealth {
	unavailable: boolean
	consecutive_api_errors: number
	/** HTTP status, or the runner's error kind (`spend_limit`, ...) when the API gave none. */
	api_error_status: number | string | null
	last_error: string | null
	/** When the current streak started (ended_at of its oldest agent). */
	since: number | null
}

type RouteHealthAgent = Pick<
	CloudAgentRow,
	'route' | 'status' | 'exit_reason' | 'created_at' | 'ended_at'
>

/** Streak length at which a route is reported unavailable. */
const ROUTE_UNAVAILABLE_STREAK = 3
/** Ended agents read per route; a longer streak reports this count and a later `since`. */
const ROUTE_HEALTH_WINDOW = 100
/** Runner format (fermi-daemon box-runner.mjs): `harness api_error <status|kind>[: detail]`. */
const API_ERROR_REASON = /^harness api_error ([^\s:]+)/

function apiErrorStatus(agent: RouteHealthAgent): string | null {
	if (agent.status !== 'failed') return null
	return agent.exit_reason?.match(API_ERROR_REASON)?.[1] ?? null
}

/** Live agents are ignored: only an ended agent extends or resets the streak. */
export function routeHealth(
	agents: RouteHealthAgent[],
	route: CloudAgentRow['route'],
): RouteHealth {
	const ended = agents
		.filter((a) => a.route === route && a.ended_at != null)
		.sort((a, b) => (b.ended_at as number) - (a.ended_at as number) || b.created_at - a.created_at)
	const status = ended[0] ? apiErrorStatus(ended[0]) : null
	if (status === null) {
		return {
			unavailable: false,
			consecutive_api_errors: 0,
			api_error_status: null,
			last_error: null,
			since: null,
		}
	}
	const brokenAt = ended.findIndex((a) => apiErrorStatus(a) !== status)
	const streak = brokenAt === -1 ? ended.length : brokenAt
	return {
		unavailable: streak >= ROUTE_UNAVAILABLE_STREAK,
		consecutive_api_errors: streak,
		api_error_status: /^\d+$/.test(status) ? Number(status) : status,
		last_error: ended[0].exit_reason,
		since: ended[streak - 1].ended_at,
	}
}

/** Own per-route query: the listCloudAgents window is newest-created across all
 * routes, so live agents and busy routes would push a route's history out of it. */
export async function listRouteHealth(
	db: D1Database,
): Promise<Record<CloudAgentRow['route'], RouteHealth>> {
	const entries = await Promise.all(
		FLEET_ROUTES.map(async (route) => {
			const { results } = await db
				.prepare(
					`SELECT route, status, exit_reason, created_at, ended_at FROM cloud_agents
					 WHERE route = ?1 AND ended_at IS NOT NULL
					 ORDER BY ended_at DESC, created_at DESC LIMIT ?2`,
				)
				.bind(route, ROUTE_HEALTH_WINDOW)
				.all<RouteHealthAgent>()
			return [route, routeHealth(results, route)] as const
		}),
	)
	return Object.fromEntries(entries) as Record<CloudAgentRow['route'], RouteHealth>
}

export async function registerBox(
	db: D1Database,
	input: {
		boxId: string
		provider?: BoxRow['provider']
		region?: string
		snapshotRef?: string
		instanceRef?: string
		mcpUrl?: string
		oauthClientId?: string
		meta?: Record<string, unknown>
	},
): Promise<BoxRow> {
	const createdAt = Date.now()
	await db
		.prepare(
			`INSERT INTO boxes (box_id, provider, region, snapshot_ref, instance_ref, mcp_url, oauth_client_id, created_at, meta)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
		)
		.bind(
			input.boxId,
			input.provider ?? 'aws',
			input.region ?? null,
			input.snapshotRef ?? null,
			input.instanceRef ?? null,
			input.mcpUrl ?? null,
			input.oauthClientId ?? null,
			createdAt,
			JSON.stringify(input.meta ?? {}),
		)
		.run()
	return (await getBox(db, input.boxId)) as BoxRow
}

export async function updateBox(
	db: D1Database,
	boxId: string,
	patch: {
		status?: BoxRow['status']
		instanceRef?: string
		mcpUrl?: string
		oauthClientId?: string
		lastHeartbeatAt?: number
		destroyedAt?: number
	},
): Promise<{ ok: boolean }> {
	const sets: string[] = []
	const binds: unknown[] = []
	const add = (col: string, val: unknown) => {
		binds.push(val)
		sets.push(`${col} = ?${binds.length}`)
	}
	if (patch.status !== undefined) add('status', patch.status)
	if (patch.instanceRef !== undefined) add('instance_ref', patch.instanceRef)
	if (patch.mcpUrl !== undefined) add('mcp_url', patch.mcpUrl)
	if (patch.oauthClientId !== undefined) add('oauth_client_id', patch.oauthClientId)
	if (patch.lastHeartbeatAt !== undefined) add('last_heartbeat_at', patch.lastHeartbeatAt)
	if (patch.destroyedAt !== undefined) add('destroyed_at', patch.destroyedAt)
	if (sets.length === 0) return { ok: true }
	binds.push(boxId)
	const { meta } = await db
		.prepare(`UPDATE boxes SET ${sets.join(', ')} WHERE box_id = ?${binds.length}`)
		.bind(...binds)
		.run()
	return { ok: meta.changes > 0 }
}

/** Heartbeat marks a live box online; destroyed boxes stay destroyed. */
export async function heartbeatBox(db: D1Database, boxId: string): Promise<{ ok: boolean }> {
	const { meta } = await db
		.prepare(
			`UPDATE boxes SET status = 'online', last_heartbeat_at = ?1
			 WHERE box_id = ?2 AND status != 'destroyed'`,
		)
		.bind(Date.now(), boxId)
		.run()
	return { ok: meta.changes > 0 }
}

/** Revocation must survive SQL status flips: destroy scrubs the token hash. */
export async function scrubBoxToken(db: D1Database, boxId: string): Promise<void> {
	const box = await getBox(db, boxId)
	if (!box) return
	let meta: Record<string, unknown> = {}
	try {
		meta = JSON.parse(box.meta)
	} catch {}
	meta.token_hash = null
	await db
		.prepare('UPDATE boxes SET meta = ?1 WHERE box_id = ?2')
		.bind(JSON.stringify(meta), boxId)
		.run()
}

export async function getBox(db: D1Database, boxId: string): Promise<BoxRow | null> {
	return await db.prepare('SELECT * FROM boxes WHERE box_id = ?1').bind(boxId).first<BoxRow>()
}

/** Reaper-scope queries: UNBOUNDED and status-filtered. The 2026-09-06 review
 * showed LIMIT windows filling with destroyed rows, emptying the live set and
 * turning the orphan sweep into a fleet massacre. Never LIMIT these. */
export async function listActiveBoxes(db: D1Database): Promise<BoxRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM boxes WHERE status != 'destroyed'")
		.all<BoxRow>()
	return results
}

export async function listReaperAgents(db: D1Database): Promise<CloudAgentRow[]> {
	const { results } = await db
		.prepare(
			`SELECT ca.* FROM cloud_agents ca
			 WHERE ca.status IN ('launching','running','waiting_human')
			    OR (ca.box_id IS NOT NULL AND EXISTS (
			         SELECT 1 FROM boxes b WHERE b.box_id = ca.box_id AND b.status != 'destroyed'))`,
		)
		.all<CloudAgentRow>()
	return results
}

export async function listBoxes(
	db: D1Database,
	opts: { status?: BoxRow['status']; limit?: number } = {},
): Promise<BoxRow[]> {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
	if (opts.status) {
		const { results } = await db
			.prepare('SELECT * FROM boxes WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2')
			.bind(opts.status, limit)
			.all<BoxRow>()
		return results
	}
	const { results } = await db
		.prepare('SELECT * FROM boxes ORDER BY created_at DESC LIMIT ?1')
		.bind(limit)
		.all<BoxRow>()
	return results
}

export async function createCloudAgent(
	db: D1Database,
	input: {
		id?: string
		queue: string
		prompt: string
		proofContract: string
		route?: CloudAgentRow['route']
		boxId?: string
		taskId?: string
		budgetUsd?: number
		ttlSeconds?: number
		instanceType?: string
	},
): Promise<CloudAgentRow> {
	const id = input.id ?? `ca_${crypto.randomUUID()}`
	await db
		.prepare(
			`INSERT INTO cloud_agents (id, box_id, task_id, queue, route, prompt, proof_contract, budget_usd, ttl_seconds, created_at, instance_type)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
		)
		.bind(
			id,
			input.boxId ?? null,
			input.taskId ?? null,
			input.queue,
			input.route ?? 'claude',
			input.prompt,
			input.proofContract,
			input.budgetUsd ?? null,
			input.ttlSeconds ?? null,
			Date.now(),
			input.instanceType ?? null,
		)
		.run()
	return (await getCloudAgent(db, id)) as CloudAgentRow
}

export async function updateCloudAgent(
	db: D1Database,
	id: string,
	patch: {
		status?: CloudAgentRow['status']
		boxId?: string
		taskId?: string
		startedAt?: number
		endedAt?: number
		exitReason?: string
		costUsd?: number
		inferenceUsd?: number
		artifactsPrefix?: string
		lastWorkingEventAt?: number
		/** Adds to restart_count (atomic in SQL). */
		restartsDelta?: number
	},
): Promise<{ ok: boolean }> {
	const sets: string[] = []
	const binds: unknown[] = []
	const add = (col: string, val: unknown) => {
		binds.push(val)
		sets.push(`${col} = ?${binds.length}`)
	}
	if (patch.status !== undefined) add('status', patch.status)
	if (patch.boxId !== undefined) add('box_id', patch.boxId)
	if (patch.taskId !== undefined) add('task_id', patch.taskId)
	if (patch.startedAt !== undefined) add('started_at', patch.startedAt)
	if (patch.endedAt !== undefined) add('ended_at', patch.endedAt)
	if (patch.exitReason !== undefined) add('exit_reason', patch.exitReason)
	if (patch.costUsd !== undefined) add('cost_usd', patch.costUsd)
	if (patch.inferenceUsd !== undefined) add('inference_usd', patch.inferenceUsd)
	if (patch.artifactsPrefix !== undefined) add('artifacts_prefix', patch.artifactsPrefix)
	if (patch.lastWorkingEventAt !== undefined) add('last_working_event_at', patch.lastWorkingEventAt)
	if (patch.restartsDelta) {
		binds.push(patch.restartsDelta)
		sets.push(`restart_count = restart_count + ?${binds.length}`)
	}
	if (sets.length === 0) return { ok: true }
	binds.push(id)
	const { meta } = await db
		.prepare(`UPDATE cloud_agents SET ${sets.join(', ')} WHERE id = ?${binds.length}`)
		.bind(...binds)
		.run()
	return { ok: meta.changes > 0 }
}

export async function getCloudAgent(db: D1Database, id: string): Promise<CloudAgentRow | null> {
	return await db
		.prepare('SELECT * FROM cloud_agents WHERE id = ?1')
		.bind(id)
		.first<CloudAgentRow>()
}

export async function withBoxHeartbeat(
	db: D1Database,
	row: CloudAgentRow,
): Promise<CloudAgentView> {
	const box = row.box_id ? await getBox(db, row.box_id) : null
	return { ...row, last_heartbeat_at: box?.last_heartbeat_at ?? null }
}

export async function listCloudAgents(
	db: D1Database,
	opts: { status?: CloudAgentRow['status']; limit?: number } = {},
): Promise<CloudAgentRow[]> {
	const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
	if (opts.status) {
		const { results } = await db
			.prepare('SELECT * FROM cloud_agents WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2')
			.bind(opts.status, limit)
			.all<CloudAgentRow>()
		return results
	}
	const { results } = await db
		.prepare('SELECT * FROM cloud_agents ORDER BY created_at DESC LIMIT ?1')
		.bind(limit)
		.all<CloudAgentRow>()
	return results
}
