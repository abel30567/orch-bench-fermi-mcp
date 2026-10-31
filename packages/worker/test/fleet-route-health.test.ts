import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import {
	createCloudAgent,
	listCloudAgents,
	listRouteHealth,
	routeHealth,
	updateCloudAgent,
} from '../src/lib/fleet-store.ts'
import { clearFleet, setupFleetSchema } from './setup-d1.ts'

type Agent = Parameters<typeof routeHealth>[0][number]

const R429 = 'harness api_error 429: Too many requests | stderr: boom'

function ended(
	endedAt: number,
	exitReason: string | null = R429,
	partial: Partial<CloudAgentRow> = {},
): Agent {
	return {
		route: 'claude',
		status: 'failed',
		exit_reason: exitReason,
		created_at: endedAt - 1,
		ended_at: endedAt,
		...partial,
	}
}

describe('routeHealth', () => {
	it('flags a route after 3 identical api errors, reporting the streak', () => {
		expect(routeHealth([ended(100), ended(200), ended(300)], 'claude')).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: 429,
			last_error: R429,
			since: 100,
		})
	})

	it('reports a building streak without flagging it', () => {
		expect(routeHealth([ended(100), ended(200)], 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 2,
			api_error_status: 429,
			since: 100,
		})
	})

	it('is healthy with no ended agents', () => {
		expect(routeHealth([], 'claude')).toEqual({
			unavailable: false,
			consecutive_api_errors: 0,
			api_error_status: null,
			last_error: null,
			since: null,
		})
	})

	it('matches status-less kinds such as a spend cap', () => {
		const reason = 'harness api_error spend_limit: Spending limit reached'
		const agents = [ended(100, reason), ended(200, reason), ended(300, reason)]
		expect(routeHealth(agents, 'claude')).toMatchObject({
			unavailable: true,
			api_error_status: 'spend_limit',
			last_error: reason,
		})
	})

	it('does not treat a longer status as the same error', () => {
		const agents = [ended(100, 'harness api_error 4290'), ended(200), ended(300)]
		expect(routeHealth(agents, 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 2,
		})
	})

	it.each([
		['success', 'completed', 'done'],
		['another failure', 'harness exited 1: oom', 'failed'],
		['runner stall', 'runner_stalled', 'failed'],
		['operator destroy naming an api error', R429, 'destroyed'],
		['missing reason', null, 'failed'],
	] as const)('resets the streak on %s', (_, reason, status) => {
		const agents = [ended(100), ended(200), ended(300), ended(400, reason, { status })]
		expect(routeHealth(agents, 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 0,
			api_error_status: null,
		})
		expect(routeHealth([...agents, ended(500)], 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 1,
			since: 500,
		})
	})

	it('restarts the streak when the status changes', () => {
		const auth = 'harness api_error 401: bad token'
		const agents = [ended(100), ended(200), ended(300), ended(400, auth)]
		expect(routeHealth(agents, 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 1,
			api_error_status: 401,
			last_error: auth,
			since: 400,
		})
	})

	it('orders by ended_at, not creation or input order', () => {
		const agents = [
			ended(300),
			// Created first but ended last: this success is the newest outcome.
			ended(400, 'completed', { status: 'done', created_at: 1 }),
			ended(100),
			ended(200),
		]
		expect(routeHealth(agents, 'claude').consecutive_api_errors).toBe(0)
	})

	it('ignores other routes and agents still running', () => {
		const agents = [
			ended(100),
			ended(150, 'completed', { status: 'done', route: 'codex' }),
			ended(200),
			ended(250, null, { status: 'running', ended_at: null }),
			ended(300),
		]
		expect(routeHealth(agents, 'claude').unavailable).toBe(true)
		expect(routeHealth(agents, 'codex').consecutive_api_errors).toBe(0)
	})
})

describe('listRouteHealth', () => {
	beforeAll(setupFleetSchema)
	beforeEach(clearFleet)

	async function seed(
		id: string,
		route: CloudAgentRow['route'],
		status: CloudAgentRow['status'],
		ending?: { endedAt: number; exitReason: string },
	) {
		await createCloudAgent(env.FERMI_DB, {
			id,
			queue: `agent:${id}`,
			prompt: 'p',
			proofContract: 'proof',
			route,
		})
		await updateCloudAgent(env.FERMI_DB, id, { status, ...ending })
	}

	it('sees a route streak older than the 50-agent listing', async () => {
		for (const [i, endedAt] of [100, 200, 300].entries()) {
			await seed(`ca_bad_${i}`, 'codex', 'failed', { endedAt, exitReason: R429 })
		}
		for (let i = 0; i < 60; i++) await seed(`ca_live_${i}`, 'claude', 'running')

		expect(await listCloudAgents(env.FERMI_DB, { limit: 50 })).toHaveLength(50)
		const routes = await listRouteHealth(env.FERMI_DB)
		expect(routes.codex).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: 429,
			last_error: R429,
			since: 100,
		})
		expect(routes.claude.unavailable).toBe(false)
		expect(routes.grok.consecutive_api_errors).toBe(0)
	})
})
