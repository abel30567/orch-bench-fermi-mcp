import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type CloudAgentRow,
	type RouteHealthAgent,
	createCloudAgent,
	getCloudAgent,
	listCloudAgents,
	listRouteHealth,
	routeHealth,
	updateCloudAgent,
} from '../src/lib/fleet-store.ts'
import type { FermiMCP } from '../src/mcp/index.ts'
import { registerCloudAgentTools } from '../src/mcp/tools/cloud-agents.ts'
import { clearFleet, setupFleetSchema } from './setup-d1.ts'

type ToolDef = { name: string; handler: (args: unknown, env: unknown) => Promise<unknown> }
const tools = vi.hoisted(() => new Map<string, ToolDef>())

vi.mock('../src/lib/tool.ts', () => ({
	defineTool: (_agent: unknown, def: ToolDef) => tools.set(def.name, def),
}))

const ERR_429 = 'harness api_error 429'
const HEALTHY = {
	unavailable: false,
	consecutive_api_errors: 0,
	api_error_status: null,
	last_error: null,
	since: null,
}

function ended(ended_at: number, exit_reason: string, partial: Partial<RouteHealthAgent> = {}) {
	return {
		route: 'claude',
		status: 'failed',
		exit_reason,
		created_at: ended_at - 10,
		ended_at,
		...partial,
	} as RouteHealthAgent
}

describe('routeHealth', () => {
	it('is healthy with no ended agents', () => {
		expect(routeHealth([], 'claude')).toEqual(HEALTHY)
	})

	it('flags three identical api errors, whatever the input order', () => {
		const agents = [ended(200, ERR_429), ended(300, ERR_429), ended(100, ERR_429)]
		expect(routeHealth(agents, 'claude')).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: 429,
			last_error: ERR_429,
			since: 100,
		})
	})

	it('reports a streak below the threshold without flagging it', () => {
		expect(routeHealth([ended(100, ERR_429), ended(200, ERR_429)], 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 2,
			api_error_status: 429,
			since: 100,
		})
	})

	it('counts past the threshold and starts the streak after the last other outcome', () => {
		const agents = [
			ended(100, 'completed', { status: 'done' }),
			...[200, 300, 400, 500].map((at) => ended(at, ERR_429)),
		]
		expect(routeHealth(agents, 'claude')).toMatchObject({
			unavailable: true,
			consecutive_api_errors: 4,
			since: 200,
		})
	})

	it('keeps the trailing detail in last_error', () => {
		const reason = 'harness api_error 402: spend cap reached'
		expect(routeHealth([ended(100, reason)], 'claude')).toMatchObject({
			api_error_status: 402,
			last_error: reason,
		})
	})

	it.each([
		['success', ended(400, 'completed', { status: 'done' })],
		['other failure', ended(400, 'runner_stalled')],
		['operator destroy', ended(400, 'destroyed_by_operator', { status: 'destroyed' })],
		['done agent quoting an api error', ended(400, ERR_429, { status: 'done' })],
		[
			'live destroy quoting an api error',
			ended(400, `destroyed: ${ERR_429}`, { status: 'destroyed' }),
		],
		['lookalike reason', ended(400, 'harness api_error unknown')],
	])('resets on %s', (_, latest) => {
		const agents = [100, 200, 300].map((at) => ended(at, ERR_429))
		expect(routeHealth([...agents, latest], 'claude')).toEqual(HEALTHY)
	})

	it('does not join different statuses into one streak', () => {
		const agents = [ended(100, ERR_429), ended(200, ERR_429), ended(300, 'harness api_error 401')]
		expect(routeHealth(agents, 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 1,
			api_error_status: 401,
			since: 300,
		})
	})

	it('keeps a failed agent in the streak after it is destroyed', () => {
		const agents = [
			ended(100, ERR_429, { status: 'destroyed' }),
			ended(200, ERR_429),
			ended(300, ERR_429),
		]
		expect(routeHealth(agents, 'claude')).toMatchObject({
			unavailable: true,
			consecutive_api_errors: 3,
			since: 100,
		})
	})

	it('orders by end time, not launch time', () => {
		// Launched last but ended first, so it sits behind the failure streak.
		const agents = [
			ended(100, 'completed', { status: 'done', created_at: 90 }),
			ended(200, ERR_429, { created_at: 10 }),
			ended(300, ERR_429, { created_at: 20 }),
			ended(400, ERR_429, { created_at: 30 }),
		]
		expect(routeHealth(agents, 'claude').unavailable).toBe(true)
	})

	it('ignores live agents and other routes', () => {
		const agents = [
			ended(100, ERR_429),
			ended(200, ERR_429),
			ended(300, ERR_429),
			ended(400, 'completed', { status: 'done', route: 'codex' }),
			{ ...ended(0, ERR_429), status: 'running', exit_reason: null, ended_at: null },
		] as RouteHealthAgent[]
		expect(routeHealth(agents, 'claude').unavailable).toBe(true)
		expect(routeHealth(agents, 'codex')).toEqual(HEALTHY)
	})
})

describe('listRouteHealth', () => {
	beforeAll(setupFleetSchema)
	beforeEach(clearFleet)

	async function seed(
		id: string,
		route: CloudAgentRow['route'],
		patch: { status: 'done' | 'failed'; exitReason: string; endedAt: number },
	) {
		await createCloudAgent(env.FERMI_DB, {
			id,
			queue: `agent:${id}`,
			prompt: 'p',
			proofContract: 'c',
			route,
		})
		await updateCloudAgent(env.FERMI_DB, id, patch)
	}

	it('reports every route as healthy on an empty fleet', async () => {
		expect(await listRouteHealth(env.FERMI_DB)).toEqual({
			claude: HEALTHY,
			codex: HEALTHY,
			grok: HEALTHY,
		})
	})

	it('keeps a quiet route flagged when a busy route fills the agents window', async () => {
		for (const at of [100, 200, 300]) {
			await seed(`ca_grok_${at}`, 'grok', { status: 'failed', exitReason: ERR_429, endedAt: at })
		}
		for (let i = 0; i < 60; i++) {
			await seed(`ca_claude_${i}`, 'claude', {
				status: 'done',
				exitReason: 'completed',
				endedAt: 1000 + i,
			})
		}
		const window = await listCloudAgents(env.FERMI_DB, { limit: 50 })
		expect(window.some((a) => a.route === 'grok')).toBe(false)
		expect(await listRouteHealth(env.FERMI_DB)).toEqual({
			claude: HEALTHY,
			codex: HEALTHY,
			grok: {
				unavailable: true,
				consecutive_api_errors: 3,
				api_error_status: 429,
				last_error: ERR_429,
				since: 100,
			},
		})
	})

	describe('after cloud_agent_destroy', () => {
		const ERR_402 = 'harness api_error 402: spend cap'
		const FLAGGED = {
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: 402,
			last_error: ERR_402,
			since: 2000,
		}
		const destroy = (id: string, reason?: string) =>
			tools.get('cloud_agent_destroy')?.handler({ id, reason }, env)
		const launch = (id: string) =>
			createCloudAgent(env.FERMI_DB, {
				id,
				queue: `agent:${id}`,
				prompt: 'p',
				proofContract: 'c',
				route: 'grok',
			})

		beforeAll(() => registerCloudAgentTools({} as FermiMCP))

		beforeEach(async () => {
			await seed('ca_old', 'grok', { status: 'done', exitReason: 'completed', endedAt: 1000 })
			for (const at of [2000, 3000, 4000]) {
				await seed(`ca_${at}`, 'grok', { status: 'failed', exitReason: ERR_402, endedAt: at })
			}
		})

		it('keeps the flag when an older finished agent is cleaned up', async () => {
			await destroy('ca_old')
			expect((await listRouteHealth(env.FERMI_DB)).grok).toEqual(FLAGGED)
			expect(await getCloudAgent(env.FERMI_DB, 'ca_old')).toMatchObject({
				status: 'destroyed',
				ended_at: 1000,
				exit_reason: 'completed',
			})
		})

		it.each(['ca_2000', 'ca_3000', 'ca_4000'])(
			'keeps failed agent %s in the streak',
			async (id) => {
				await destroy(id, 'cleanup')
				expect((await listRouteHealth(env.FERMI_DB)).grok).toEqual(FLAGGED)
			},
		)

		it('resets when a live agent is destroyed', async () => {
			await launch('ca_live')
			await destroy('ca_live')
			expect((await listRouteHealth(env.FERMI_DB)).grok).toEqual(HEALTHY)
			expect(await getCloudAgent(env.FERMI_DB, 'ca_live')).toMatchObject({
				status: 'destroyed',
				exit_reason: 'destroyed_by_operator',
			})
		})

		it('resets when a live agent is destroyed with an api_error reason', async () => {
			await launch('ca_live')
			await destroy('ca_live', ERR_402)
			expect((await listRouteHealth(env.FERMI_DB)).grok).toEqual(HEALTHY)
		})
	})
})
