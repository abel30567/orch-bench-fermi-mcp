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

export const FLEET_ROUTES: CloudAgentRow['route'][] = ['claude', 'codex', 'grok']

/** A route goes unavailable after this many back-to-back identical API errors. */
export const ROUTE_API_ERROR_THRESHOLD = 3

export interface RouteHealth {
	unavailable: boolean
	consecutive_api_errors: number
	/** Token after `harness api_error` (e.g. `429`); null when there is no streak. */
	api_error_status: string | null
	/** Exit reason of the most recently ended agent in the streak. */
	last_error: string | null
	/** ended_at of the first agent in the current streak. */
	since: number | null
}

const API_ERROR_RE = /^harness api_error ([^\s:]+)/

/** Streak of failed agents sharing one `harness api_error <status>` exit reason,
 * counted back from the most recently ended agent on the route. Any other
 * outcome (success, other failure, different status) ends the streak. */
export function routeHealth(agents: CloudAgentRow[], route: CloudAgentRow['route']): RouteHealth {
	const ended = agents
		.filter((a) => a.route === route && a.ended_at !== null)
		.sort((a, b) => (b.ended_at as number) - (a.ended_at as number))
	let status: string | null = null
	let lastError: string | null = null
	let since: number | null = null
	let count = 0
	for (const a of ended) {
		const match = a.status === 'failed' ? API_ERROR_RE.exec(a.exit_reason ?? '') : null
		if (!match || (status !== null && match[1] !== status)) break
		if (status === null) {
			status = match[1]
			lastError = a.exit_reason
		}
		since = a.ended_at
		count++
	}
	return {
		unavailable: count >= ROUTE_API_ERROR_THRESHOLD,
		consecutive_api_errors: count,
		api_error_status: status,
		last_error: lastError,
		since,
	}
}

/** Most recently ended agents on one route, independent of the status page's
 * created_at window so a busy route can't push another route's history out. */
export async function listRecentEndedAgents(
	db: D1Database,
	route: CloudAgentRow['route'],
	limit = 20,
): Promise<CloudAgentRow[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM cloud_agents WHERE route = ?1 AND ended_at IS NOT NULL
			 ORDER BY ended_at DESC LIMIT ?2`,
		)
		.bind(route, limit)
		.all<CloudAgentRow>()
	return results
}

export async function getRoutesHealth(
	db: D1Database,
): Promise<Record<CloudAgentRow['route'], RouteHealth>> {
	const entries = await Promise.all(
		FLEET_ROUTES.map(
			async (route) => [route, routeHealth(await listRecentEndedAgents(db, route), route)] as const,
		),
	)
	return Object.fromEntries(entries) as Record<CloudAgentRow['route'], RouteHealth>
}
