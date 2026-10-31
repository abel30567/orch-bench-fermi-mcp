import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleBoxInferenceAuth, sha256Hex } from '../src/channels/box-gateway.ts'
import { launchCloudAgent } from '../src/lib/fleet-launch.ts'
import {
	type CloudAgentRow,
	ROUTE_UNAVAILABLE_THRESHOLD,
	createCloudAgent,
	registerBox,
	routeHealth,
} from '../src/lib/fleet-store.ts'
import { putSecret } from '../src/lib/secrets-store.ts'

const fenv = env as unknown as Env

// Schema mirrors migrations 0004 (secrets), 0017/0020/0021/0023 (fleet).
const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS secrets (name TEXT NOT NULL, scope TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', encrypted_value BLOB NOT NULL, iv BLOB NOT NULL, allowed_hosts TEXT NOT NULL DEFAULT '[]', allowed_capabilities TEXT NOT NULL DEFAULT '[]', allowed_packages TEXT NOT NULL DEFAULT '[]', key_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (name, scope, session_id))`,
	`CREATE TABLE IF NOT EXISTS boxes (box_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'aws', status TEXT NOT NULL DEFAULT 'provisioning', instance_ref TEXT, mcp_url TEXT, oauth_client_id TEXT, region TEXT, snapshot_ref TEXT, last_heartbeat_at INTEGER, created_at INTEGER NOT NULL, destroyed_at INTEGER, meta TEXT NOT NULL DEFAULT '{}')`,
	`CREATE TABLE IF NOT EXISTS cloud_agents (id TEXT PRIMARY KEY, box_id TEXT, task_id TEXT, queue TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'launching', route TEXT NOT NULL DEFAULT 'claude', prompt TEXT NOT NULL, proof_contract TEXT NOT NULL, budget_usd REAL, ttl_seconds INTEGER, cost_usd REAL NOT NULL DEFAULT 0, inference_usd REAL NOT NULL DEFAULT 0, exit_reason TEXT, artifacts_prefix TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, instance_type TEXT, last_working_event_at INTEGER, restart_count INTEGER NOT NULL DEFAULT 0, account TEXT)`,
]

const PROOF = JSON.stringify({ kind: 'artifact', name: 'out.txt' })
const base = { prompt: 'do the thing please', proof_contract: PROOF }

const secret = (name: string, value: string) => putSecret({ name, scope: 'app', value }, fenv)

beforeAll(async () => {
	for (const sql of SCHEMA) await fenv.FERMI_DB.prepare(sql).run()
})
beforeEach(async () => {
	for (const t of ['secrets', 'boxes', 'cloud_agents'])
		await fenv.FERMI_DB.prepare(`DELETE FROM ${t}`).run()
})

describe('launchCloudAgent account validation', () => {
	it('rejects an account on a non-claude route', async () => {
		const r = await launchCloudAgent(fenv, { ...base, route: 'codex', account: 'alt' })
		expect(r).toMatchObject({ ok: false, error: 'account_requires_claude_route' })
	})

	it('rejects a malformed account id', async () => {
		for (const account of ['Alt', '1alt', 'a-b', '', 'a'.repeat(33), '../x']) {
			const r = await launchCloudAgent(fenv, { ...base, account })
			expect(r).toMatchObject({ ok: false, error: 'invalid_account' })
		}
	})

	it('rejects an account whose token secret is missing', async () => {
		await secret('CLAUDE_CODE_OAUTH_TOKEN', 'default-token')
		const r = await launchCloudAgent(fenv, { ...base, account: 'alt_2' })
		expect(r).toMatchObject({
			ok: false,
			error: 'account_token_not_configured',
			missing: ['CLAUDE_CODE_OAUTH_TOKEN_ALT_2'],
		})
	})
})

describe('/box/inference-auth with an account', () => {
	async function boxFor(account?: string) {
		const agent = await createCloudAgent(fenv.FERMI_DB, {
			queue: 'agent:x',
			prompt: 'p',
			proofContract: PROOF,
			route: 'claude',
			account,
		})
		const boxId = `box-${crypto.randomUUID()}`
		await registerBox(fenv.FERMI_DB, {
			boxId,
			meta: { token_hash: await sha256Hex('s3cret'), agent_id: agent.id },
		})
		await fenv.FERMI_DB.prepare("UPDATE boxes SET status = 'online' WHERE box_id = ?1")
			.bind(boxId)
			.run()
		return {
			agent,
			req: () =>
				new Request('https://x/box/inference-auth', {
					method: 'POST',
					headers: { authorization: `Bearer ${boxId}.s3cret` },
				}),
		}
	}

	it('stores the account on the agent row', async () => {
		const { agent } = await boxFor('alt')
		expect(agent.account).toBe('alt')
	})

	it('serves the account token under the standard name', async () => {
		await secret('CLAUDE_CODE_OAUTH_TOKEN', 'default-token')
		await secret('CLAUDE_CODE_OAUTH_TOKEN_ALT', 'alt-token')
		const { req } = await boxFor('alt')
		const res = await handleBoxInferenceAuth(req(), fenv)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			ok: true,
			route: 'claude',
			secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'alt-token' },
		})
	})

	it('serves the default token when no account is set', async () => {
		await secret('CLAUDE_CODE_OAUTH_TOKEN', 'default-token')
		await secret('CLAUDE_CODE_OAUTH_TOKEN_ALT', 'alt-token')
		const { req } = await boxFor()
		const body = (await (await handleBoxInferenceAuth(req(), fenv)).json()) as {
			secrets: Record<string, string>
		}
		expect(body.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'default-token' })
	})

	it('reports the account secret as missing (never falls back to default)', async () => {
		await secret('CLAUDE_CODE_OAUTH_TOKEN', 'default-token')
		const { req } = await boxFor('alt')
		const res = await handleBoxInferenceAuth(req(), fenv)
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ missing: ['CLAUDE_CODE_OAUTH_TOKEN_ALT'] })
	})
})

describe('routeHealth per account', () => {
	const failed = (i: number, account: string | null): CloudAgentRow =>
		({
			id: `ca_${account}_${i}`,
			route: 'claude',
			account,
			ended_at: 1000 + i,
			exit_reason: 'harness api_error 429: rate limited',
		}) as CloudAgentRow

	it('scopes health to one account; default excludes alternates', () => {
		const agents = Array.from({ length: ROUTE_UNAVAILABLE_THRESHOLD }, (_, i) => failed(i, 'alt'))
		expect(routeHealth(agents, 'claude', 'alt')).toMatchObject({
			account: 'alt',
			unavailable: true,
			api_error_status: '429',
		})
		expect(routeHealth(agents, 'claude')).toMatchObject({
			account: null,
			unavailable: false,
			consecutive_api_errors: 0,
		})
	})

	it('default-account failures do not mark an alternate unavailable', () => {
		const agents = Array.from({ length: ROUTE_UNAVAILABLE_THRESHOLD }, (_, i) => failed(i, null))
		expect(routeHealth(agents, 'claude').unavailable).toBe(true)
		expect(routeHealth(agents, 'claude', 'alt').unavailable).toBe(false)
	})
})
