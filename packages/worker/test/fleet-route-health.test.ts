import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import {
	createCloudAgent,
	fleetRouteHealth,
	routeHealth,
	updateCloudAgent,
} from '../src/lib/fleet-store.ts'
import { clearFleet, setupFleetSchema } from './setup-d1.ts'

let seq = 0
const agent = (p: Partial<CloudAgentRow>): CloudAgentRow => ({
	id: `ca_${++seq}`,
	box_id: null,
	task_id: null,
	queue: 'agent:x',
	status: 'failed',
	route: 'claude',
	prompt: 'p',
	proof_contract: 'c',
	budget_usd: null,
	ttl_seconds: null,
	cost_usd: 0,
	inference_usd: 0,
	exit_reason: null,
	artifacts_prefix: null,
	created_at: 0,
	started_at: 0,
	ended_at: null,
	instance_type: null,
	last_working_event_at: null,
	restart_count: 0,
	...p,
})
const apiErr = (status: string, ended_at: number, route: CloudAgentRow['route'] = 'claude') =>
	agent({ route, ended_at, exit_reason: `harness api_error ${status}` })

describe('routeHealth', () => {
	it('flags a route unavailable after 3 consecutive same-status api errors', () => {
		const h = routeHealth([apiErr('429', 300), apiErr('429', 100), apiErr('429', 200)], 'claude')
		expect(h).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: '429',
			last_error: 'harness api_error 429',
			since: 100,
		})
	})

	it('is healthy with fewer than 3 matching errors', () => {
		const h = routeHealth([apiErr('402', 200), apiErr('402', 100)], 'claude')
		expect(h).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 2,
			api_error_status: '402',
		})
		expect(routeHealth([], 'claude')).toEqual({
			unavailable: false,
			consecutive_api_errors: 0,
			api_error_status: null,
			last_error: null,
			since: null,
		})
	})

	it('resets the streak on any other outcome', () => {
		const success = agent({ status: 'done', ended_at: 400, exit_reason: 'completed' })
		const otherFail = agent({ ended_at: 400, exit_reason: 'ttl_expired' })
		const base = [apiErr('429', 300), apiErr('429', 200), apiErr('429', 100)]
		expect(routeHealth([success, ...base], 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 0,
		})
		expect(routeHealth([otherFail, ...base], 'claude').unavailable).toBe(false)
		// A different api_error status breaks the streak too.
		expect(routeHealth([apiErr('401', 400), ...base], 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 1,
			api_error_status: '401',
		})
		// A success in the middle splits the run.
		const split = [apiErr('429', 500), apiErr('429', 400), success, ...base]
		expect(routeHealth(split, 'claude').consecutive_api_errors).toBe(2)
	})

	it('only considers ended agents on the requested route', () => {
		const running = agent({ status: 'running', ended_at: null })
		const agents = [
			running,
			apiErr('429', 300, 'codex'),
			apiErr('429', 200),
			apiErr('429', 100),
			apiErr('429', 50),
		]
		expect(routeHealth(agents, 'claude')).toMatchObject({ unavailable: true, since: 50 })
		expect(routeHealth(agents, 'codex')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 1,
		})
		expect(routeHealth(agents, 'grok').consecutive_api_errors).toBe(0)
	})

	it('ignores api_error exit reasons on non-failed agents', () => {
		const odd = agent({ status: 'done', ended_at: 400, exit_reason: 'harness api_error 429' })
		const h = routeHealth(
			[odd, apiErr('429', 300), apiErr('429', 200), apiErr('429', 100)],
			'claude',
		)
		expect(h.unavailable).toBe(false)
	})
})

describe('fleetRouteHealth (D1, /admin/fleet/status routes block)', () => {
	beforeAll(async () => {
		await setupFleetSchema()
	})
	beforeEach(async () => {
		await clearFleet()
	})

	it('reports every route, flagging the one whose last 3 ended agents hit the same api error', async () => {
		const end = async (
			id: string,
			route: CloudAgentRow['route'],
			endedAt: number,
			status: 'done' | 'failed',
			exitReason: string,
		) => {
			await createCloudAgent(env.FERMI_DB, {
				id,
				queue: `agent:${id}`,
				prompt: 'p',
				proofContract: 'c',
				route,
			})
			await updateCloudAgent(env.FERMI_DB, id, { status, endedAt, exitReason })
		}
		await end('a0', 'claude', 1000, 'done', 'completed')
		await end('a1', 'claude', 2000, 'failed', 'harness api_error 402')
		await end('a2', 'claude', 3000, 'failed', 'harness api_error 402')
		await end('a3', 'claude', 4000, 'failed', 'harness api_error 402')
		await end('b1', 'codex', 2000, 'failed', 'harness api_error 429')
		await end('b2', 'codex', 3000, 'failed', 'harness api_error 429')
		await end('b3', 'codex', 4000, 'done', 'completed')
		await createCloudAgent(env.FERMI_DB, {
			id: 'r1',
			queue: 'agent:r1',
			prompt: 'p',
			proofContract: 'c',
			route: 'claude',
		})

		const routes = await fleetRouteHealth(env.FERMI_DB)
		expect(routes.claude).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: '402',
			last_error: 'harness api_error 402',
			since: 2000,
		})
		expect(routes.codex).toMatchObject({ unavailable: false, consecutive_api_errors: 0 })
		expect(routes.grok).toMatchObject({ unavailable: false, consecutive_api_errors: 0 })
	})
})
