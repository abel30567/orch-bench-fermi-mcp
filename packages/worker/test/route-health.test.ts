import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import {
	type CloudAgentRow,
	createCloudAgent,
	listRouteHealth,
	routeHealth,
	updateCloudAgent,
} from '../src/lib/fleet-store.ts'
import { setupFleetSchema } from './setup-d1.ts'

type Row = Pick<CloudAgentRow, 'route' | 'status' | 'exit_reason' | 'ended_at'>

const fail = (ended_at: number, exit_reason: string, route: Row['route'] = 'claude'): Row => ({
	route,
	status: 'failed',
	exit_reason,
	ended_at,
})

describe('routeHealth', () => {
	it('is healthy with no ended agents', () => {
		expect(routeHealth([], 'claude')).toEqual({
			unavailable: false,
			consecutive_api_errors: 0,
			api_error_status: null,
			last_error: null,
			since: null,
		})
	})

	it('flags a route after 3 consecutive same-status api errors', () => {
		const h = routeHealth(
			[
				fail(3, 'harness api_error 429'),
				fail(1, 'harness api_error 429'),
				fail(2, 'harness api_error 429'),
				fail(9, 'harness api_error 401', 'codex'),
			],
			'claude',
		)
		expect(h).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: 429,
			last_error: 'harness api_error 429',
			since: 1,
		})
	})

	it('does not flag with only 2 api errors', () => {
		const h = routeHealth(
			[fail(2, 'harness api_error 429'), fail(1, 'harness api_error 429')],
			'claude',
		)
		expect(h.unavailable).toBe(false)
		expect(h.consecutive_api_errors).toBe(2)
	})

	it('any other outcome resets the streak', () => {
		const h = routeHealth(
			[
				fail(5, 'harness api_error 429'),
				{ route: 'claude', status: 'done', exit_reason: 'proof_ok', ended_at: 4 },
				fail(3, 'harness api_error 429'),
				fail(2, 'harness api_error 429'),
				fail(1, 'harness api_error 429'),
			],
			'claude',
		)
		expect(h.unavailable).toBe(false)
		expect(h.consecutive_api_errors).toBe(1)
		expect(h.since).toBe(5)
	})

	it('different statuses do not combine', () => {
		const h = routeHealth(
			[
				fail(3, 'harness api_error 402'),
				fail(2, 'harness api_error 429'),
				fail(1, 'harness api_error 429'),
			],
			'claude',
		)
		expect(h.unavailable).toBe(false)
		expect(h.consecutive_api_errors).toBe(1)
		expect(h.api_error_status).toBe(402)
	})

	it('ignores agents that have not ended', () => {
		const h = routeHealth(
			[
				{ route: 'claude', status: 'running', exit_reason: null, ended_at: null },
				fail(3, 'harness api_error 401'),
				fail(2, 'harness api_error 401'),
				fail(1, 'harness api_error 401'),
			],
			'claude',
		)
		expect(h.unavailable).toBe(true)
	})
})

describe('listRouteHealth', () => {
	beforeAll(async () => {
		await setupFleetSchema(env.FERMI_DB)
	})

	it('reports every route from D1', async () => {
		for (let i = 1; i <= 3; i++) {
			const a = await createCloudAgent(env.FERMI_DB, {
				queue: `rh-${i}`,
				prompt: 'p',
				proofContract: 'c',
				route: 'grok',
			})
			await updateCloudAgent(env.FERMI_DB, a.id, {
				status: 'failed',
				endedAt: 1000 + i,
				exitReason: 'harness api_error 429',
			})
		}
		const routes = await listRouteHealth(env.FERMI_DB)
		expect(Object.keys(routes).sort()).toEqual(['claude', 'codex', 'grok'])
		expect(routes.grok.unavailable).toBe(true)
		expect(routes.grok.since).toBe(1001)
	})
})
