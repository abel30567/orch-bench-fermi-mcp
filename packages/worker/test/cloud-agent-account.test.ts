import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleBoxInferenceAuth, sha256Hex } from '../src/channels/box-gateway.ts'
import { launchCloudAgent } from '../src/lib/fleet-launch.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import {
	accountTokenSecretName,
	createCloudAgent,
	fleetRouteHealth,
	getCloudAgent,
	registerBox,
	routeHealth,
} from '../src/lib/fleet-store.ts'
import { putSecret } from '../src/lib/secrets-store.ts'

// Self-contained schema (mirrors migrations 0004/0012/0017/0020/0021/0023).
const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS secrets (
		name TEXT NOT NULL, scope TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
		encrypted_value BLOB NOT NULL, iv BLOB NOT NULL,
		allowed_hosts TEXT NOT NULL DEFAULT '[]', allowed_capabilities TEXT NOT NULL DEFAULT '[]',
		allowed_packages TEXT NOT NULL DEFAULT '[]', key_version INTEGER NOT NULL DEFAULT 1,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
		PRIMARY KEY (name, scope, session_id))`,
	`CREATE TABLE IF NOT EXISTS boxes (
		box_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'aws',
		status TEXT NOT NULL DEFAULT 'provisioning', instance_ref TEXT, mcp_url TEXT,
		oauth_client_id TEXT, region TEXT, snapshot_ref TEXT, last_heartbeat_at INTEGER,
		created_at INTEGER NOT NULL, destroyed_at INTEGER, meta TEXT NOT NULL DEFAULT '{}')`,
	`CREATE TABLE IF NOT EXISTS cloud_agents (
		id TEXT PRIMARY KEY, box_id TEXT, task_id TEXT, queue TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'launching', route TEXT NOT NULL DEFAULT 'claude',
		prompt TEXT NOT NULL, proof_contract TEXT NOT NULL, budget_usd REAL, ttl_seconds INTEGER,
		cost_usd REAL NOT NULL DEFAULT 0, exit_reason TEXT, artifacts_prefix TEXT,
		created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
		inference_usd REAL NOT NULL DEFAULT 0, instance_type TEXT, last_working_event_at INTEGER,
		restart_count INTEGER NOT NULL DEFAULT 0, account TEXT)`,
	`CREATE TABLE IF NOT EXISTS tasks (
		id TEXT PRIMARY KEY, channel TEXT NOT NULL, sender TEXT NOT NULL, chat_id TEXT NOT NULL,
		payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT,
		created_at INTEGER NOT NULL, claimed_at INTEGER, completed_at INTEGER,
		queue TEXT NOT NULL DEFAULT 'default', parent_task_id TEXT)`,
]

const PROOF = '{"kind":"artifact","name":"out.txt"}'
const base = { prompt: 'do the thing please', proof_contract: PROOF }

async function setSecret(name: string, value: string) {
	await putSecret({ name, scope: 'app', value }, env)
}

beforeAll(async () => {
	for (const sql of SCHEMA) await env.FERMI_DB.prepare(sql).run()
})

beforeEach(async () => {
	for (const t of ['secrets', 'boxes', 'cloud_agents', 'tasks']) {
		await env.FERMI_DB.prepare(`DELETE FROM ${t}`).run()
	}
})

describe('launch account validation', () => {
	it('rejects an account on a non-claude route', async () => {
		await setSecret('CLAUDE_CODE_OAUTH_TOKEN_ALT', 'tok')
		const r = await launchCloudAgent(env, { ...base, route: 'codex', account: 'alt' })
		expect(r).toMatchObject({ ok: false, error: 'account_requires_claude_route' })
	})

	it.each(['Alt', '1alt', 'alt-2', '', 'a'.repeat(33)])('rejects malformed id %j', async (id) => {
		const r = await launchCloudAgent(env, { ...base, account: id })
		expect(r).toMatchObject({ ok: false, error: 'invalid_account' })
	})

	it('rejects an account whose token secret is missing', async () => {
		const r = await launchCloudAgent(env, { ...base, account: 'alt_2' })
		expect(r).toMatchObject({
			ok: false,
			error: 'account_token_not_configured',
			secret: 'CLAUDE_CODE_OAUTH_TOKEN_ALT_2',
		})
		const { n } = (await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM cloud_agents').first<{
			n: number
		}>()) ?? { n: -1 }
		expect(n).toBe(0)
	})

	// A targeted box skips the FleetDO reservation and provisioning.
	async function launchOnBox(account?: string) {
		const box = await registerBox(env.FERMI_DB, { boxId: `box_${crypto.randomUUID()}` })
		const r = await launchCloudAgent(env, { ...base, account, box_id: box.box_id })
		if (!r.ok) throw new Error(`launch failed: ${r.error}`)
		return getCloudAgent(env.FERMI_DB, r.agent_id)
	}

	it('stores the account on the launched agent row', async () => {
		await setSecret('CLAUDE_CODE_OAUTH_TOKEN_ALT', 'tok')
		expect((await launchOnBox('alt'))?.account).toBe('alt')
	})

	it('stores no account on a default launch', async () => {
		expect((await launchOnBox())?.account ?? null).toBeNull()
	})

	it('maps the account id to an uppercase secret suffix', () => {
		expect(accountTokenSecretName('alt_2')).toBe('CLAUDE_CODE_OAUTH_TOKEN_ALT_2')
	})
})

describe('/box/inference-auth with an account', () => {
	async function boxFor(account?: string) {
		const agent = await createCloudAgent(env.FERMI_DB, {
			queue: 'agent:x',
			prompt: base.prompt,
			proofContract: PROOF,
			account,
		})
		const box = await registerBox(env.FERMI_DB, {
			boxId: `box_${crypto.randomUUID()}`,
			meta: { agent_id: agent.id, token_hash: await sha256Hex('s3cret') },
		})
		return { agent, box }
	}
	const call = (boxId: string) =>
		handleBoxInferenceAuth(
			new Request('https://fermi.test/box/inference-auth', {
				method: 'POST',
				headers: { authorization: `Bearer ${boxId}.s3cret` },
			}),
			env,
		)

	it('stores the account on the agent row', async () => {
		const { agent } = await boxFor('alt')
		expect(agent.account).toBe('alt')
	})

	it('serves the account token under the standard name', async () => {
		await setSecret('CLAUDE_CODE_OAUTH_TOKEN', 'default-tok')
		await setSecret('CLAUDE_CODE_OAUTH_TOKEN_ALT', 'alt-tok')
		const { box } = await boxFor('alt')
		const body = (await (await call(box.box_id)).json()) as { secrets: Record<string, string> }
		expect(body.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'alt-tok' })
	})

	it('keeps serving the default token without an account', async () => {
		await setSecret('CLAUDE_CODE_OAUTH_TOKEN', 'default-tok')
		await setSecret('CLAUDE_CODE_OAUTH_TOKEN_ALT', 'alt-tok')
		const { box } = await boxFor()
		const body = (await (await call(box.box_id)).json()) as { secrets: Record<string, string> }
		expect(body.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'default-tok' })
	})

	it('reports the missing account secret by its real name', async () => {
		const { box } = await boxFor('alt')
		const res = await call(box.box_id)
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ missing: ['CLAUDE_CODE_OAUTH_TOKEN_ALT'] })
	})
})

describe('routeHealth per account', () => {
	const ended = (i: number, account: string | null, exit: string) =>
		({
			id: `ca_${i}`,
			route: 'claude',
			account,
			ended_at: 1000 + i,
			exit_reason: exit,
		}) as CloudAgentRow
	const agents = [
		ended(1, 'alt', 'harness api_error 429: limit'),
		ended(2, 'alt', 'harness api_error 429: limit'),
		ended(3, 'alt', 'harness api_error 429: limit'),
		ended(4, null, 'completed'),
	]

	it('flags only the exhausted account', () => {
		expect(routeHealth(agents, 'claude', 'alt')).toMatchObject({
			account: 'alt',
			unavailable: true,
			consecutive_api_errors: 3,
		})
		expect(routeHealth(agents, 'claude')).toMatchObject({
			account: null,
			unavailable: false,
			consecutive_api_errors: 0,
		})
	})
})

describe('fleetRouteHealth', () => {
	const ended = (i: number, route: CloudAgentRow['route'], account: string | null, exit: string) =>
		({ id: `ca_${i}`, route, account, ended_at: 1000 + i, exit_reason: exit }) as CloudAgentRow
	const routes = fleetRouteHealth([
		ended(1, 'claude', 'alt', 'harness api_error 429: limit'),
		ended(2, 'claude', 'alt', 'harness api_error 429: limit'),
		ended(3, 'claude', 'alt', 'harness api_error 429: limit'),
		ended(4, 'claude', 'beta', 'harness api_error 401: auth'),
		ended(5, 'claude', null, 'completed'),
		ended(6, 'codex', 'ignored', 'harness api_error 429: limit'),
	])

	it('emits one key per alternate claude account beside the base routes', () => {
		expect(Object.keys(routes).sort()).toEqual([
			'claude',
			'claude:alt',
			'claude:beta',
			'codex',
			'grok',
		])
	})

	it('scopes each key to its own account', () => {
		expect(routes['claude:alt']).toMatchObject({
			account: 'alt',
			unavailable: true,
			consecutive_api_errors: 3,
		})
		expect(routes['claude:beta']).toMatchObject({
			account: 'beta',
			unavailable: false,
			consecutive_api_errors: 1,
		})
		expect(routes.claude).toMatchObject({ account: null, unavailable: false })
	})
})
