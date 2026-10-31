import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleBoxInferenceAuth, sha256Hex } from '../src/channels/box-gateway.ts'
import { launchCloudAgent } from '../src/lib/fleet-launch.ts'
import {
	type CloudAgentRow,
	ROUTE_UNAVAILABLE_THRESHOLD,
	createCloudAgent,
	getCloudAgent,
	registerBox,
	routeAccounts,
	routeHealth,
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

const PROOF = '{"kind":"test","cmd":"true"}'
const SECRET = 'acct-secret'

const workerEnv = env as unknown as Env

function launch(extra: Record<string, unknown>) {
	return launchCloudAgent(workerEnv, {
		prompt: 'do the account thing',
		proof_contract: PROOF,
		...extra,
	})
}

describe('cloud agent alternate Claude account', () => {
	beforeAll(async () => {
		await setupFleetSchema()
		await setupTasksSchema()
		await setupSecretsSchema()
	})
	beforeEach(async () => {
		await clearFleet()
		await clearTasks()
		await clearSecrets()
		await registerBox(env.FERMI_DB, { boxId: 'box-p', provider: 'private' })
	})

	it('rejects an account on a non-claude route', async () => {
		const res = await launch({ route: 'codex', account: 'work' })
		expect(res).toMatchObject({ ok: false, error: 'account_requires_claude_route' })
	})

	it('rejects a malformed account id', async () => {
		for (const account of ['Work', '1work', 'work-x', '', 'a'.repeat(33)]) {
			const res = await launch({ account })
			expect(res).toMatchObject({ ok: false, error: 'invalid_account' })
		}
	})

	it('fails fast when the account token secret is missing', async () => {
		const res = await launch({ account: 'work', box_id: 'box-p' })
		expect(res).toMatchObject({
			ok: false,
			error: 'account_token_not_configured',
			secret: 'CLAUDE_CODE_OAUTH_TOKEN_WORK',
		})
		const { results } = await env.FERMI_DB.prepare('SELECT id FROM cloud_agents').all()
		expect(results).toHaveLength(0)
	})

	it('stores the account on the agent row when the secret exists', async () => {
		await putSecret(
			{ name: 'CLAUDE_CODE_OAUTH_TOKEN_WORK', value: 'tok-work', scope: 'app' },
			workerEnv,
		)
		const res = await launch({ account: 'work', box_id: 'box-p' })
		expect(res.ok).toBe(true)
		if (!res.ok) return
		const row = await getCloudAgent(env.FERMI_DB, res.agent_id)
		expect(row?.account).toBe('work')
	})

	it('defaults the account to null', async () => {
		const res = await launch({ box_id: 'box-p' })
		expect(res.ok).toBe(true)
		if (!res.ok) return
		expect((await getCloudAgent(env.FERMI_DB, res.agent_id))?.account).toBeNull()
	})

	async function seedBox(account?: string) {
		await registerBox(env.FERMI_DB, {
			boxId: 'box-a',
			meta: { agent_id: 'ca_acct', token_hash: await sha256Hex(SECRET) },
		})
		await createCloudAgent(env.FERMI_DB, {
			id: 'ca_acct',
			queue: 'agent:ca_acct',
			prompt: 'p',
			proofContract: PROOF,
			boxId: 'box-a',
			account,
		})
	}

	function authReq(): Request {
		return new Request('https://fermi.test/box/inference-auth', {
			method: 'POST',
			headers: { authorization: `Bearer box-a.${SECRET}` },
		})
	}

	it('/box/inference-auth serves the account token under the standard name', async () => {
		await putSecret(
			{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok-default', scope: 'app' },
			workerEnv,
		)
		await putSecret(
			{ name: 'CLAUDE_CODE_OAUTH_TOKEN_WORK', value: 'tok-work', scope: 'app' },
			workerEnv,
		)
		await seedBox('work')
		const res = await handleBoxInferenceAuth(authReq(), workerEnv)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { secrets: Record<string, string> }
		expect(body.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-work' })
	})

	it('/box/inference-auth serves the default token without an account', async () => {
		await putSecret(
			{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok-default', scope: 'app' },
			workerEnv,
		)
		await seedBox()
		const res = await handleBoxInferenceAuth(authReq(), workerEnv)
		const body = (await res.json()) as { secrets: Record<string, string> }
		expect(body.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-default' })
	})

	it('/box/inference-auth names the missing account secret', async () => {
		await seedBox('work')
		const res = await handleBoxInferenceAuth(authReq(), workerEnv)
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ missing: ['CLAUDE_CODE_OAUTH_TOKEN_WORK'] })
	})
})

describe('per-account route health', () => {
	function ended(id: string, account: string | null, at: number, exit: string): CloudAgentRow {
		return {
			id,
			box_id: null,
			task_id: null,
			queue: `agent:${id}`,
			status: 'failed',
			route: 'claude',
			prompt: 'p',
			proof_contract: PROOF,
			budget_usd: null,
			ttl_seconds: null,
			cost_usd: 0,
			inference_usd: 0,
			exit_reason: exit,
			artifacts_prefix: null,
			created_at: at,
			started_at: at,
			ended_at: at,
			instance_type: null,
			last_working_event_at: null,
			restart_count: 0,
			account,
		}
	}

	const capped = Array.from({ length: ROUTE_UNAVAILABLE_THRESHOLD }, (_, i) =>
		ended(`ca_w${i}`, 'work', 100 + i, 'harness api_error 429: spend cap'),
	)

	it('scopes failures to the account', () => {
		const agents = [ended('ca_d', null, 50, 'done'), ...capped]
		expect(routeHealth(agents, 'claude', 'work').unavailable).toBe(true)
		expect(routeHealth(agents, 'claude').unavailable).toBe(false)
		expect(routeHealth(agents, 'claude').consecutive_api_errors).toBe(0)
		expect(routeAccounts(agents, 'claude')).toEqual(['work'])
	})

	it('default-account failures do not mark an alternate account unavailable', () => {
		const agents = capped.map((a) => ({ ...a, account: null }))
		expect(routeHealth(agents, 'claude').unavailable).toBe(true)
		expect(routeHealth(agents, 'claude', 'work').unavailable).toBe(false)
	})
})
