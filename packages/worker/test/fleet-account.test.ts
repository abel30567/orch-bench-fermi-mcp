import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleBoxInferenceAuth, sha256Hex } from '../src/channels/box-gateway.ts'
import { launchCloudAgent } from '../src/lib/fleet-launch.ts'
import {
	type CloudAgentRow,
	createCloudAgent,
	fleetRoutesHealth,
	getCloudAgent,
	listCloudAgents,
	registerBox,
	routeHealth,
	updateCloudAgent,
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

const CONTRACT = JSON.stringify({ kind: 'artifact', name: 'out.diff', min_bytes: 1 })
const SECRET = 'acct-secret'

async function privateBox(boxId = 'box-acct') {
	await registerBox(env.FERMI_DB, {
		boxId,
		provider: 'private',
		meta: { token_hash: await sha256Hex(SECRET) },
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

	it('launch fails fast on a non-claude route', async () => {
		const out = await launchCloudAgent(env, {
			prompt: 'do the thing please',
			proof_contract: CONTRACT,
			route: 'codex',
			account: 'work',
		})
		expect(out).toMatchObject({ ok: false, error: 'account_requires_claude_route' })
	})

	it('launch fails fast on a malformed account id', async () => {
		for (const bad of ['Work', '1abc', 'a-b', '', 'a'.repeat(33), '../x']) {
			const out = await launchCloudAgent(env, {
				prompt: 'do the thing please',
				proof_contract: CONTRACT,
				account: bad,
			})
			expect(out, bad).toMatchObject({ ok: false, error: 'invalid_account' })
		}
	})

	it('launch fails fast when the account secret is missing', async () => {
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN', scope: 'app', value: 'default' }, env)
		const out = await launchCloudAgent(env, {
			prompt: 'do the thing please',
			proof_contract: CONTRACT,
			account: 'work',
		})
		expect(out).toMatchObject({
			ok: false,
			error: 'account_token_not_configured',
			missing: 'CLAUDE_CODE_OAUTH_TOKEN_WORK',
		})
	})

	it('stores the account on the agent row and inference-auth serves it under the standard name', async () => {
		await privateBox()
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN', scope: 'app', value: 'default-oat' }, env)
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN_WORK_2', scope: 'app', value: 'alt-oat' }, env)
		const out = await launchCloudAgent(env, {
			prompt: 'do the thing please',
			proof_contract: CONTRACT,
			box_id: 'box-acct',
			account: 'work_2',
		})
		expect(out.ok).toBe(true)
		if (!out.ok) return
		const row = await getCloudAgent(env.FERMI_DB, out.agent_id)
		expect(row?.account).toBe('work_2')

		// Bind the box to the agent, as provisioning does.
		await env.FERMI_DB.prepare('UPDATE boxes SET meta = ?1 WHERE box_id = ?2')
			.bind(
				JSON.stringify({ agent_id: out.agent_id, token_hash: await sha256Hex(SECRET) }),
				'box-acct',
			)
			.run()
		const res = await handleBoxInferenceAuth(
			new Request('https://fermi.test/box/inference-auth', {
				method: 'POST',
				headers: { authorization: `Bearer box-acct.${SECRET}` },
				body: '{}',
			}),
			env,
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { secrets: Record<string, string> }
		expect(body.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'alt-oat' })
	})

	it('a launch without account keeps account null and uses the default token', async () => {
		await privateBox()
		const out = await launchCloudAgent(env, {
			prompt: 'do the thing please',
			proof_contract: CONTRACT,
			box_id: 'box-acct',
		})
		expect(out.ok).toBe(true)
		if (!out.ok) return
		expect((await getCloudAgent(env.FERMI_DB, out.agent_id))?.account).toBeNull()
	})

	it('inference-auth 409s naming the account secret when it was removed after launch', async () => {
		await registerBox(env.FERMI_DB, {
			boxId: 'box-acct',
			provider: 'aws',
			meta: { agent_id: 'ca_acct', token_hash: await sha256Hex(SECRET) },
		})
		await createCloudAgent(env.FERMI_DB, {
			id: 'ca_acct',
			queue: 'agent:ca_acct',
			prompt: 'p',
			proofContract: CONTRACT,
			account: 'work',
		})
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN', scope: 'app', value: 'default-oat' }, env)
		const res = await handleBoxInferenceAuth(
			new Request('https://fermi.test/box/inference-auth', {
				method: 'POST',
				headers: { authorization: `Bearer box-acct.${SECRET}` },
				body: '{}',
			}),
			env,
		)
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ missing: ['CLAUDE_CODE_OAUTH_TOKEN_WORK'] })
	})

	it('MCP launch schema accepts account', () => {
		expect(cloudAgentLaunchSchema.account.parse('work')).toBe('work')
		expect(cloudAgentLaunchSchema.account.parse(undefined)).toBeUndefined()
	})

	it('fleet status routes: routes.claude plus routes["claude:<account>"]', async () => {
		const cap = 'harness api_error 429: spend limit'
		for (let i = 0; i < 3; i++) {
			await createCloudAgent(env.FERMI_DB, {
				id: `ca_w${i}`,
				queue: `agent:ca_w${i}`,
				prompt: 'p',
				proofContract: CONTRACT,
				account: 'work',
			})
			await updateCloudAgent(env.FERMI_DB, `ca_w${i}`, {
				status: 'failed',
				endedAt: 100 + i,
				exitReason: cap,
			})
		}
		const body = { routes: fleetRoutesHealth(await listCloudAgents(env.FERMI_DB, { limit: 50 })) }
		expect(body.routes.claude).toMatchObject({ unavailable: false, consecutive_api_errors: 0 })
		expect(body.routes['claude:work']).toMatchObject({
			account: 'work',
			unavailable: true,
			consecutive_api_errors: 3,
		})
		expect(Object.keys(body.routes).sort()).toEqual(['claude', 'claude:work', 'codex', 'grok'])
	})
})

describe('routeHealth per account', () => {
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

	it('scopes the streak to one account; default covers only the default account', () => {
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
		expect(routeHealth(agents, 'claude')).not.toHaveProperty('account')
		expect(routeHealth(agents, 'claude', 'alt')).toMatchObject({
			route: 'claude',
			account: 'alt',
			unavailable: true,
			consecutive_api_errors: 3,
		})
		expect(routeHealth(agents, 'claude', 'other')).toMatchObject({ consecutive_api_errors: 0 })
	})
})
