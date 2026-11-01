import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { handleBoxInferenceAuth, sha256Hex } from '../src/channels/box-gateway.ts'
import { launchCloudAgent } from '../src/lib/fleet-launch.ts'
import {
	type CloudAgentRow,
	fleetRouteHealth,
	getCloudAgent,
	listCloudAgents,
	registerBox,
	routeHealth,
} from '../src/lib/fleet-store.ts'
import { putSecret } from '../src/lib/secrets-store.ts'
import { cloudAgentLaunchSchema } from '../src/mcp/tools/cloud-agents.ts'
import {
	clearFleet,
	clearSecrets,
	clearTasks,
	setupFleetSchema,
	setupSecretsSchema,
	setupTasksSchema,
} from './setup-d1.ts'

const PROOF = '{"kind":"artifact","name":"out.diff","min_bytes":1}'
const SECRET = 'acct-secret'

async function privateBox(agentId?: string) {
	await registerBox(env.FERMI_DB, {
		boxId: 'box-acct',
		provider: 'private',
		meta: { token_hash: await sha256Hex(SECRET), ...(agentId ? { agent_id: agentId } : {}) },
	})
}

describe('alternate Claude account per launch', () => {
	beforeAll(async () => {
		await setupFleetSchema()
		await setupTasksSchema()
		await setupSecretsSchema()
	})
	beforeEach(async () => {
		await clearFleet()
		await clearTasks()
		await clearSecrets()
	})

	it('schema accepts a well-formed account and rejects malformed ids', () => {
		const schema = z.object(cloudAgentLaunchSchema)
		const base = { prompt: 'build feature X end to end', proof_contract: PROOF }
		expect(schema.parse({ ...base, account: 'work_2' }).account).toBe('work_2')
		for (const bad of ['Work', '2nd', '', 'a-b', `a${'b'.repeat(32)}`]) {
			expect(schema.safeParse({ ...base, account: bad }).success).toBe(false)
		}
	})

	it('fails fast on a non-claude route, a malformed id, or a missing secret', async () => {
		const base = { prompt: 'build feature X end to end', proof_contract: PROOF }
		expect(await launchCloudAgent(env, { ...base, route: 'codex', account: 'work' })).toMatchObject(
			{ ok: false, error: 'account_requires_claude_route' },
		)
		expect(await launchCloudAgent(env, { ...base, account: 'Bad-Id' })).toMatchObject({
			ok: false,
			error: 'invalid_account',
		})
		expect(await launchCloudAgent(env, { ...base, account: 'work' })).toMatchObject({
			ok: false,
			error: 'account_token_not_configured',
			secret: 'CLAUDE_CODE_OAUTH_TOKEN_WORK',
		})
		const { results } = await env.FERMI_DB.prepare('SELECT id FROM cloud_agents').all()
		expect(results).toHaveLength(0)
	})

	it('stores the account and serves its token to the box under the standard name', async () => {
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN', scope: 'app', value: 'oat-default' }, env)
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN_WORK', scope: 'app', value: 'oat-work' }, env)
		await privateBox()
		const launched = await launchCloudAgent(env, {
			prompt: 'build feature X end to end',
			proof_contract: PROOF,
			box_id: 'box-acct',
			account: 'work',
		})
		if (!launched.ok) throw new Error(launched.error)
		expect((await getCloudAgent(env.FERMI_DB, launched.agent_id))?.account).toBe('work')

		await env.FERMI_DB.prepare('UPDATE boxes SET meta = ?1 WHERE box_id = ?2')
			.bind(
				JSON.stringify({ token_hash: await sha256Hex(SECRET), agent_id: launched.agent_id }),
				'box-acct',
			)
			.run()
		const res = await handleBoxInferenceAuth(
			new Request('https://fermi.test/box/inference-auth', {
				method: 'POST',
				headers: { authorization: `Bearer box-acct.${SECRET}` },
			}),
			env,
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			ok: true,
			route: 'claude',
			secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'oat-work' },
		})
	})

	it('a launch without account keeps the default token and a null column', async () => {
		await privateBox()
		const launched = await launchCloudAgent(env, {
			prompt: 'build feature X end to end',
			proof_contract: PROOF,
			box_id: 'box-acct',
		})
		if (!launched.ok) throw new Error(launched.error)
		expect((await getCloudAgent(env.FERMI_DB, launched.agent_id))?.account).toBeNull()
	})

	it('fleet status routes report claude health per account', async () => {
		const cap = 'harness api_error 429: spend limit'
		const insert = (id: string, account: string | null, endedAt: number) =>
			env.FERMI_DB.prepare(
				`INSERT INTO cloud_agents (id, queue, status, route, prompt, proof_contract, created_at, ended_at, exit_reason, account)
				 VALUES (?1, ?2, 'failed', 'claude', 'p', 'c', ?3, ?3, ?4, ?5)`,
			)
				.bind(id, `agent:${id}`, endedAt, cap, account)
				.run()
		await insert('a1', 'work', 1)
		await insert('a2', 'work', 2)
		await insert('a3', 'work', 3)
		await insert('a4', null, 4)
		// Same agent list + mapping /admin/fleet/status serves.
		const body = { routes: fleetRouteHealth(await listCloudAgents(env.FERMI_DB, { limit: 50 })) }
		expect(body.routes.claude).toMatchObject({ unavailable: false, consecutive_api_errors: 1 })
		expect(body.routes['claude:work']).toMatchObject({
			unavailable: true,
			consecutive_api_errors: 3,
		})
		expect(Object.keys(body.routes).sort()).toEqual(['claude', 'claude:work', 'codex', 'grok'])
	})
})

describe('routeHealth account scope', () => {
	const agent = (p: Partial<CloudAgentRow>): CloudAgentRow =>
		({
			route: 'claude',
			status: 'failed',
			ended_at: 1,
			exit_reason: null,
			account: null,
			...p,
		}) as CloudAgentRow
	const cap = 'harness api_error 429: spend limit'

	it('without account covers only the default account; with account only that one', () => {
		const agents = [
			agent({ ended_at: 30, exit_reason: cap, account: 'alt' }),
			agent({ ended_at: 20, exit_reason: cap, account: 'alt' }),
			agent({ ended_at: 10, exit_reason: cap, account: 'alt' }),
			agent({ ended_at: 5, exit_reason: 'completed', status: 'done' }),
		]
		expect(routeHealth(agents, 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 0,
		})
		expect(routeHealth(agents, 'claude', 'alt')).toMatchObject({
			unavailable: true,
			consecutive_api_errors: 3,
		})
		expect(routeHealth(agents, 'claude', 'other')).toMatchObject({ consecutive_api_errors: 0 })
	})
})
