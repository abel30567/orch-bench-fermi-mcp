import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import m0004 from '../migrations/0004_secrets.sql?raw'
import m0012 from '../migrations/0012_task_queue.sql?raw'
import m0017 from '../migrations/0017_cloud_fleet.sql?raw'
import m0020 from '../migrations/0020_inference_usd.sql?raw'
import m0021 from '../migrations/0021_fleet_resilience.sql?raw'
import m0023 from '../migrations/0023_cloud_agent_account.sql?raw'
import { handleBoxInferenceAuth, sha256Hex } from '../src/channels/box-gateway.ts'
import { launchCloudAgent } from '../src/lib/fleet-launch.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import {
	createCloudAgent,
	fleetRouteHealth,
	getCloudAgent,
	registerBox,
	routeHealth,
} from '../src/lib/fleet-store.ts'
import { putSecret } from '../src/lib/secrets-store.ts'

const workerEnv = env as unknown as Env
const CONTRACT = JSON.stringify({ kind: 'artifact', name: 'out.txt' })

async function applyMigrations(...files: string[]) {
	for (const sql of files) {
		const body = sql
			.split('\n')
			.filter((l) => !l.trim().startsWith('--'))
			.join('\n')
		for (const stmt of body.split(';')) {
			if (stmt.trim()) await env.FERMI_DB.prepare(stmt).run()
		}
	}
}

function agent(partial: Partial<CloudAgentRow>): CloudAgentRow {
	return {
		id: 'ca_x',
		box_id: null,
		task_id: null,
		queue: 'agent:ca_x',
		status: 'failed',
		route: 'claude',
		prompt: 'p',
		proof_contract: 'proof',
		budget_usd: null,
		ttl_seconds: null,
		cost_usd: 0,
		inference_usd: 0,
		exit_reason: null,
		artifacts_prefix: null,
		created_at: 0,
		started_at: null,
		ended_at: null,
		instance_type: null,
		last_working_event_at: null,
		restart_count: 0,
		account: null,
		...partial,
	}
}

const capped = (id: string, endedAt: number, account: string | null) =>
	agent({ id, account, ended_at: endedAt, exit_reason: 'harness api_error 429: spend cap' })

describe('routeHealth per account', () => {
	const agents = [
		capped('a1', 3, 'alt'),
		capped('a2', 2, 'alt'),
		capped('a3', 1, 'alt'),
		agent({ id: 'd1', ended_at: 3, exit_reason: 'completed' }),
	]

	it('scopes to the named account', () => {
		const h = routeHealth(agents, 'claude', 'alt')
		expect(h).toMatchObject({ account: 'alt', unavailable: true, consecutive_api_errors: 3 })
	})

	it('without account covers the default account only', () => {
		const h = routeHealth(agents, 'claude')
		expect(h).toMatchObject({ account: null, unavailable: false, consecutive_api_errors: 0 })
	})
})

describe('fleet status routes (/admin/fleet/status)', () => {
	it('reports routes.claude plus routes["claude:<account>"]', () => {
		const agents = [
			capped('a1', 3, 'alt'),
			capped('a2', 2, 'alt'),
			capped('a3', 1, 'alt'),
			agent({ id: 'd1', ended_at: 3, exit_reason: 'completed' }),
			agent({ id: 'c1', route: 'codex' }),
		]
		const routes = fleetRouteHealth(agents)
		expect(Object.keys(routes).sort()).toEqual(['claude', 'claude:alt', 'codex', 'grok'])
		expect(routes.claude).toMatchObject({ account: null, unavailable: false })
		expect(routes['claude:alt']).toMatchObject({ account: 'alt', unavailable: true })
	})
})

describe('launchCloudAgent account validation', () => {
	beforeAll(async () => {
		await applyMigrations(m0004, m0012, m0017, m0020, m0021, m0023)
	})
	beforeEach(async () => {
		await env.FERMI_DB.prepare('DELETE FROM secrets').run()
	})

	const base = { prompt: 'do the thing please', proof_contract: CONTRACT }

	it('rejects an account on a non-claude route', async () => {
		const r = await launchCloudAgent(workerEnv, { ...base, route: 'codex', account: 'alt' })
		expect(r).toMatchObject({ ok: false, error: 'account_requires_claude_route' })
	})

	it.each(['Alt', '1alt', 'alt-x', '', `a${'b'.repeat(32)}`])(
		'rejects malformed account %j',
		async (account) => {
			const r = await launchCloudAgent(workerEnv, { ...base, account })
			expect(r).toMatchObject({ ok: false, error: 'invalid_account' })
		},
	)

	it('rejects an account whose token secret is missing', async () => {
		const r = await launchCloudAgent(workerEnv, { ...base, account: 'alt' })
		expect(r).toMatchObject({
			ok: false,
			error: 'account_token_not_configured',
			missing: ['CLAUDE_CODE_OAUTH_TOKEN_ALT'],
		})
	})
})

describe('/box/inference-auth with an account', () => {
	beforeAll(async () => {
		await applyMigrations(m0004, m0012, m0017, m0020, m0021, m0023)
	})
	beforeEach(async () => {
		await env.FERMI_DB.prepare('DELETE FROM secrets').run()
		await env.FERMI_DB.prepare('DELETE FROM cloud_agents').run()
		await env.FERMI_DB.prepare('DELETE FROM boxes').run()
	})

	async function boxFor(account?: string) {
		const created = await createCloudAgent(env.FERMI_DB, {
			id: 'ca_acct',
			queue: 'agent:ca_acct',
			prompt: 'p',
			proofContract: CONTRACT,
			account,
		})
		await registerBox(env.FERMI_DB, {
			boxId: 'box-acct',
			meta: { agent_id: created.id, token_hash: await sha256Hex('s3cret') },
		})
		return created
	}

	const call = () =>
		handleBoxInferenceAuth(
			new Request('https://x/box/inference-auth', {
				method: 'POST',
				headers: { authorization: 'Bearer box-acct.s3cret' },
			}),
			workerEnv,
		)

	it('stores the account on the agent row', async () => {
		await boxFor('alt')
		expect((await getCloudAgent(env.FERMI_DB, 'ca_acct'))?.account).toBe('alt')
	})

	it('serves the account token under the standard name', async () => {
		await boxFor('alt')
		await putSecret(
			{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'default-tok', scope: 'app' },
			workerEnv,
		)
		await putSecret(
			{ name: 'CLAUDE_CODE_OAUTH_TOKEN_ALT', value: 'alt-tok', scope: 'app' },
			workerEnv,
		)
		const body = await (await call()).json()
		expect(body).toEqual({
			ok: true,
			route: 'claude',
			secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'alt-tok' },
		})
	})

	it('reports the account secret as missing', async () => {
		await boxFor('alt')
		await putSecret(
			{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'default-tok', scope: 'app' },
			workerEnv,
		)
		const res = await call()
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ missing: ['CLAUDE_CODE_OAUTH_TOKEN_ALT'] })
	})

	it('keeps the default token for agents without an account', async () => {
		await boxFor()
		await putSecret(
			{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'default-tok', scope: 'app' },
			workerEnv,
		)
		const body = (await (await call()).json()) as { secrets: Record<string, string> }
		expect(body.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'default-tok' })
	})
})
