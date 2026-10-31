import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleBoxInferenceAuth, sha256Hex } from '../src/channels/box-gateway.ts'
import { launchCloudAgent } from '../src/lib/fleet-launch.ts'
import {
	type CloudAgentRow,
	getCloudAgent,
	registerBox,
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

const SECRET = 'acct-secret'
const PROOF = JSON.stringify({ kind: 'test', cmd: 'true' })

async function secret(name: string, value: string) {
	await putSecret({ name, value, scope: 'app' }, env)
}

async function launchOnBox(extra: Record<string, unknown>) {
	const result = await launchCloudAgent(env, {
		prompt: 'do the thing please',
		proof_contract: PROOF,
		box_id: 'box-a',
		...extra,
	})
	if (!result.ok) throw new Error(result.error)
	// Point the box at the new agent so /box/inference-auth resolves it.
	await env.FERMI_DB.prepare('UPDATE boxes SET meta = ?1 WHERE box_id = ?2')
		.bind(
			JSON.stringify({ agent_id: result.agent_id, token_hash: await sha256Hex(SECRET) }),
			'box-a',
		)
		.run()
	return result
}

function authReq(): Request {
	return new Request('https://fermi.test/box/inference-auth', {
		method: 'POST',
		headers: { authorization: `Bearer box-a.${SECRET}` },
	})
}

describe('per-launch Claude account', () => {
	beforeAll(async () => {
		await setupFleetSchema()
		await setupTasksSchema()
		await setupSecretsSchema()
	})
	beforeEach(async () => {
		await clearFleet()
		await clearTasks()
		await clearSecrets()
		await registerBox(env.FERMI_DB, { boxId: 'box-a', provider: 'private' })
	})

	it('rejects an account on a non-claude route', async () => {
		const r = await launchCloudAgent(env, {
			prompt: 'do the thing please',
			proof_contract: PROOF,
			route: 'codex',
			account: 'alt',
		})
		expect(r).toMatchObject({ ok: false, error: 'account_requires_claude_route' })
	})

	it('rejects a malformed account id', async () => {
		for (const account of ['Alt', '1alt', 'alt-x', '', `a${'b'.repeat(32)}`]) {
			const r = await launchCloudAgent(env, { prompt: 'p', proof_contract: PROOF, account })
			expect(r).toMatchObject({ ok: false, error: 'invalid_account' })
		}
	})

	it('rejects an account whose token secret is missing', async () => {
		const r = await launchCloudAgent(env, { prompt: 'p', proof_contract: PROOF, account: 'alt' })
		expect(r).toMatchObject({ ok: false, error: 'account_token_not_configured' })
	})

	it('stores the account and serves its token under the standard name', async () => {
		await secret('CLAUDE_CODE_OAUTH_TOKEN', 'default-token')
		await secret('CLAUDE_CODE_OAUTH_TOKEN_ALT_2', 'alt-token')
		const launched = await launchOnBox({ account: 'alt_2' })
		expect((await getCloudAgent(env.FERMI_DB, launched.agent_id))?.account).toBe('alt_2')

		const res = await handleBoxInferenceAuth(authReq(), env)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { secrets: Record<string, string> }
		expect(body.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'alt-token' })
	})

	it('default launches keep the default token and a null account', async () => {
		await secret('CLAUDE_CODE_OAUTH_TOKEN', 'default-token')
		const launched = await launchOnBox({})
		expect((await getCloudAgent(env.FERMI_DB, launched.agent_id))?.account).toBeNull()
		const body = (await (await handleBoxInferenceAuth(authReq(), env)).json()) as {
			secrets: Record<string, string>
		}
		expect(body.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'default-token' })
	})
})

describe('routeHealth per account', () => {
	const agent = (i: number, account: string | null, exit: string): CloudAgentRow =>
		({
			id: `ca_${i}`,
			route: 'claude',
			account,
			ended_at: 1000 + i,
			exit_reason: exit,
		}) as CloudAgentRow

	it('scopes the failure streak to one account', () => {
		const agents = [
			agent(1, 'alt', 'harness api_error 429: spend cap'),
			agent(2, 'alt', 'harness api_error 429: spend cap'),
			agent(3, 'alt', 'harness api_error 429: spend cap'),
			agent(4, null, 'done'),
		]
		const def = routeHealth(agents, 'claude')
		expect(def).toMatchObject({ account: null, unavailable: false, consecutive_api_errors: 0 })
		const alt = routeHealth(agents, 'claude', 'alt')
		expect(alt).toMatchObject({ account: 'alt', unavailable: true, consecutive_api_errors: 3 })
	})
})
