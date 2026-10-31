import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleBoxInferenceAuth, sha256Hex } from '../src/channels/box-gateway.ts'
import { claudeAccountSecret, isClaudeAccount } from '../src/lib/fleet-config.ts'
import { launchCloudAgent } from '../src/lib/fleet-launch.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import {
	createCloudAgent,
	fleetRouteHealth,
	getCloudAgent,
	listCloudAgents,
	registerBox,
	routeHealth,
} from '../src/lib/fleet-store.ts'
import { putSecret } from '../src/lib/secrets-store.ts'

// The real migrations, so the suite proves 0023 applies on top of the fleet schema.
const sql = import.meta.glob('../migrations/*.sql', {
	query: '?raw',
	import: 'default',
	eager: true,
}) as Record<string, string>

async function applyMigration(prefix: string) {
	const file = Object.keys(sql).find((k) => k.includes(`/${prefix}_`)) as string
	const statements = sql[file]
		.replace(/--.*$/gm, '')
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean)
	for (const s of statements) await env.FERMI_DB.prepare(s).run()
}

const launch = {
	prompt: 'do the thing please',
	proof_contract: '{"kind":"artifact","name":"proof.txt"}',
}

const setSecret = (name: string, value: string) =>
	putSecret({ name, scope: 'app', value }, env as unknown as Env)

async function agentCount() {
	const row = await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM cloud_agents').first<{
		n: number
	}>()
	return row?.n
}

async function boxRequest(agentId: string) {
	const secret = 'box-secret'
	await registerBox(env.FERMI_DB, {
		boxId: `box-${agentId}`,
		meta: { agent_id: agentId, token_hash: await sha256Hex(secret) },
	})
	return new Request('https://fermi.test/box/inference-auth', {
		headers: { authorization: `Bearer box-${agentId}.${secret}` },
	})
}

function ended(account: string | null, exit: string, at: number): CloudAgentRow {
	return { route: 'claude', account, exit_reason: exit, ended_at: at } as CloudAgentRow
}

beforeAll(async () => {
	for (const m of ['0004', '0012', '0017', '0020', '0021', '0023']) await applyMigration(m)
})

beforeEach(async () => {
	await env.FERMI_DB.prepare('DELETE FROM cloud_agents').run()
	await env.FERMI_DB.prepare('DELETE FROM boxes').run()
	await env.FERMI_DB.prepare('DELETE FROM tasks').run()
	await env.FERMI_DB.prepare('DELETE FROM secrets').run()
})

describe('account ids', () => {
	it('accepts only ^[a-z][a-z0-9_]{0,31}$ strings', () => {
		for (const ok of ['a', 'alt_2', `a${'b'.repeat(31)}`]) expect(isClaudeAccount(ok)).toBe(true)
		for (const bad of ['', 'Alt', '1alt', '_alt', 'a-b', 'alt\n', `a${'b'.repeat(32)}`, ['alt']]) {
			expect(isClaudeAccount(bad)).toBe(false)
		}
	})

	it('maps to the uppercased secret name', () => {
		expect(claudeAccountSecret('alt_2')).toBe('CLAUDE_CODE_OAUTH_TOKEN_ALT_2')
	})
})

describe('launchCloudAgent account', () => {
	it('stores the account on the agent row', async () => {
		await setSecret('CLAUDE_CODE_OAUTH_TOKEN_ALT', 'tok-alt')
		const result = await launchCloudAgent(env as unknown as Env, { ...launch, account: 'alt' })
		expect(result.ok).toBe(true)
		const id = (result as { agent_id: string }).agent_id
		expect((await getCloudAgent(env.FERMI_DB, id))?.account).toBe('alt')
	})

	it('leaves account null when omitted', async () => {
		const result = await launchCloudAgent(env as unknown as Env, launch)
		expect(result.ok).toBe(true)
		expect((await listCloudAgents(env.FERMI_DB))[0].account).toBeNull()
	})

	it.each([
		[{ route: 'codex' as const, account: 'alt' }, 'account_requires_claude_route'],
		[{ route: 'grok' as const, account: 'alt' }, 'account_requires_claude_route'],
		[{ account: 'Not-Valid' }, 'invalid_account'],
		[{ account: '' }, 'invalid_account'],
		[{ route: 'claude' as const, account: 'ghost' }, 'account_token_not_configured'],
	])('fails fast without creating an agent: %j', async (extra, error) => {
		await setSecret('CLAUDE_CODE_OAUTH_TOKEN_ALT', 'tok-alt')
		const result = await launchCloudAgent(env as unknown as Env, { ...launch, ...extra })
		expect(result).toMatchObject({ ok: false, error })
		expect(await agentCount()).toBe(0)
	})
})

describe('/box/inference-auth account', () => {
	const create = (account?: string) =>
		createCloudAgent(env.FERMI_DB, {
			queue: 'agent:x',
			prompt: 'p',
			proofContract: 'c',
			account,
		})

	it('serves the account token under the standard name only', async () => {
		await setSecret('CLAUDE_CODE_OAUTH_TOKEN', 'tok-default')
		await setSecret('CLAUDE_CODE_OAUTH_TOKEN_ALT', 'tok-alt')
		const agent = await create('alt')
		const res = await handleBoxInferenceAuth(await boxRequest(agent.id), env as unknown as Env)
		expect(await res.json()).toEqual({
			ok: true,
			route: 'claude',
			secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-alt' },
		})
	})

	it('keeps serving the default token to default agents', async () => {
		await setSecret('CLAUDE_CODE_OAUTH_TOKEN', 'tok-default')
		await setSecret('CLAUDE_CODE_OAUTH_TOKEN_ALT', 'tok-alt')
		const agent = await create()
		const res = await handleBoxInferenceAuth(await boxRequest(agent.id), env as unknown as Env)
		const body = (await res.json()) as { secrets: Record<string, string> }
		expect(body.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-default' })
	})

	it('does not fall back to the default token if the account secret vanished', async () => {
		await setSecret('CLAUDE_CODE_OAUTH_TOKEN', 'tok-default')
		const agent = await create('alt')
		const res = await handleBoxInferenceAuth(await boxRequest(agent.id), env as unknown as Env)
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({
			ok: false,
			missing: ['CLAUDE_CODE_OAUTH_TOKEN_ALT'],
		})
	})
})

describe('route health per account', () => {
	const capped = (account: string | null, at: number) =>
		ended(account, 'harness api_error 429: spend cap', at)

	it('scopes to one account, and to the default account without one', () => {
		const agents = [capped('alt', 3), capped('alt', 2), capped('alt', 1)]
		expect(routeHealth(agents, 'claude', 'alt').unavailable).toBe(true)
		expect(routeHealth(agents, 'claude').consecutive_api_errors).toBe(0)
	})

	it('does not let another account break a run of failures', () => {
		const agents = [capped(null, 5), ended('alt', 'completed', 4), capped(null, 3), capped(null, 2)]
		expect(routeHealth(agents, 'claude').unavailable).toBe(true)
	})

	it('reports claude plus one claude:<account> entry per account seen', () => {
		const routes = fleetRouteHealth([capped('alt', 3), capped('alt', 2), capped('alt', 1)])
		expect(Object.keys(routes).sort()).toEqual(['claude', 'claude:alt', 'codex', 'grok'])
		expect(routes['claude:alt'].unavailable).toBe(true)
		expect(routes.claude.unavailable).toBe(false)
	})
})
