import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleBoxInferenceAuth, sha256Hex } from '../src/channels/box-gateway.ts'
import { launchCloudAgent } from '../src/lib/fleet-launch.ts'
import {
	type CloudAgentRow,
	createCloudAgent,
	fleetRouteHealth,
	getCloudAgent,
	listCloudAgents,
	registerBox,
	routeHealth,
	updateCloudAgent,
} from '../src/lib/fleet-store.ts'
import { putSecret } from '../src/lib/secrets-store.ts'
import {
	clearFleet,
	clearSecrets,
	clearTasks,
	setupFleetSchema,
	setupSecretsSchema,
	setupTasksSchema,
} from './setup-d1.ts'

const SECRET = 'box-secret'
const PROOF = '{"kind":"artifact","name":"out.txt"}'
const BASE = { prompt: 'do the thing', proof_contract: PROOF }

async function agentCount(): Promise<number> {
	const row = await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM cloud_agents').first<{
		n: number
	}>()
	return row?.n ?? 0
}

async function seedBoxAgent(agentId: string, account?: string): Promise<Request> {
	await registerBox(env.FERMI_DB, {
		boxId: 'box-a',
		meta: { agent_id: agentId, token_hash: await sha256Hex(SECRET) },
	})
	await createCloudAgent(env.FERMI_DB, {
		id: agentId,
		queue: `agent:${agentId}`,
		prompt: 'p',
		proofContract: PROOF,
		account,
	})
	return new Request('https://fermi.test/box/inference-auth', {
		method: 'POST',
		headers: { authorization: `Bearer box-a.${SECRET}` },
	})
}

beforeAll(async () => {
	await setupFleetSchema()
	await setupSecretsSchema()
	await setupTasksSchema()
})

beforeEach(async () => {
	await clearFleet()
	await clearSecrets()
	await clearTasks()
})

describe('launchCloudAgent account', () => {
	it('rejects an account on a non-claude route', async () => {
		const result = await launchCloudAgent(env, { ...BASE, route: 'codex', account: 'alt' })
		expect(result).toMatchObject({ ok: false, error: 'account_requires_claude_route' })
		expect(await agentCount()).toBe(0)
	})

	it.each(['', 'Alt', '1alt', 'a-b', 'alt\n', 'a'.repeat(33)])(
		'rejects the malformed id %j',
		async (account) => {
			const result = await launchCloudAgent(env, { ...BASE, account })
			expect(result).toMatchObject({ ok: false, error: 'invalid_account' })
		},
	)

	it('rejects a non-string id from the unparsed admin body', async () => {
		const account = ['alt'] as unknown as string
		const result = await launchCloudAgent(env, { ...BASE, account })
		expect(result).toMatchObject({ ok: false, error: 'invalid_account' })
	})

	it('fails fast when the account secret is missing', async () => {
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'default', scope: 'app' }, env)
		const result = await launchCloudAgent(env, { ...BASE, account: 'alt' })
		expect(result).toMatchObject({ ok: false, error: 'account_token_not_configured' })
		expect(await agentCount()).toBe(0)
	})

	it('stores the account on the agent row', async () => {
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN_ALT_2', value: 'tok', scope: 'app' }, env)
		await registerBox(env.FERMI_DB, { boxId: 'box-private', provider: 'private' })
		const result = await launchCloudAgent(env, {
			...BASE,
			account: 'alt_2',
			box_id: 'box-private',
		})
		if (!result.ok) throw new Error(result.error)
		expect((await getCloudAgent(env.FERMI_DB, result.agent_id))?.account).toBe('alt_2')
	})
})

describe('/box/inference-auth account', () => {
	it('serves the account token under the standard name', async () => {
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'default', scope: 'app' }, env)
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN_ALT', value: 'alt-token', scope: 'app' }, env)
		const res = await handleBoxInferenceAuth(await seedBoxAgent('ca_alt', 'alt'), env)
		expect(await res.json()).toEqual({
			ok: true,
			route: 'claude',
			secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'alt-token' },
		})
	})

	it('keeps serving the default token without an account', async () => {
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'default', scope: 'app' }, env)
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN_ALT', value: 'alt-token', scope: 'app' }, env)
		const res = await handleBoxInferenceAuth(await seedBoxAgent('ca_default'), env)
		expect(await res.json()).toMatchObject({
			secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'default' },
		})
	})

	it('never falls back to the default token when the account secret is gone', async () => {
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'default', scope: 'app' }, env)
		const res = await handleBoxInferenceAuth(await seedBoxAgent('ca_gone', 'alt'), env)
		expect(res.status).toBe(409)
		expect(await res.json()).toEqual({
			ok: false,
			error: 'inference_auth_not_configured',
			missing: ['CLAUDE_CODE_OAUTH_TOKEN_ALT'],
		})
	})
})

describe('per-account route health', () => {
	const failed = (id: string, account: string | null, endedAt: number) =>
		({
			id,
			route: 'claude',
			account,
			ended_at: endedAt,
			exit_reason: 'harness api_error 429: limit',
		}) as CloudAgentRow

	const agents = [1, 2, 3].map((n) => failed(`ca_${n}`, 'alt', n))

	it('scopes an exhausted account away from the default account', () => {
		expect(routeHealth(agents, 'claude', 'alt')).toMatchObject({
			unavailable: true,
			consecutive_api_errors: 3,
		})
		expect(routeHealth(agents, 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 0,
		})
		expect(routeHealth(agents, 'claude', 'other').consecutive_api_errors).toBe(0)
	})

	it('does not let another account break the default run', () => {
		const mixed = [...[1, 2, 3].map((n) => failed(`ca_${n}`, null, n)), failed('ca_4', 'alt', 4)]
		mixed[3].exit_reason = 'completed'
		expect(routeHealth(mixed, 'claude').unavailable).toBe(true)
	})

	it('reports each stored account alongside the default', async () => {
		for (const n of [1, 2, 3]) {
			await createCloudAgent(env.FERMI_DB, {
				id: `ca_${n}`,
				queue: `agent:ca_${n}`,
				prompt: 'p',
				proofContract: PROOF,
				account: 'alt',
			})
			await updateCloudAgent(env.FERMI_DB, `ca_${n}`, {
				status: 'failed',
				endedAt: n,
				exitReason: 'harness api_error 429: limit',
			})
		}
		const routes = fleetRouteHealth(await listCloudAgents(env.FERMI_DB))
		expect(Object.keys(routes).sort()).toEqual(['claude', 'claude:alt', 'codex', 'grok'])
		expect(routes['claude:alt'].unavailable).toBe(true)
		expect(routes.claude.unavailable).toBe(false)
	})
})
