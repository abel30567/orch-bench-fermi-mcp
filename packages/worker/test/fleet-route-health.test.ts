import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import {
	createCloudAgent,
	getRoutesHealth,
	routeHealth,
	updateCloudAgent,
} from '../src/lib/fleet-store.ts'
import { clearFleet, setupFleetSchema } from './setup-d1.ts'

const NOW = 1_800_000_000_000

let seq = 0
function ended(
	exitReason: string,
	endedAt: number,
	partial: Partial<CloudAgentRow> = {},
): CloudAgentRow {
	seq++
	return {
		id: `ca_${seq}`,
		box_id: null,
		task_id: null,
		queue: `agent:ca_${seq}`,
		status: exitReason.startsWith('completed') ? 'done' : 'failed',
		route: 'claude',
		prompt: 'p',
		proof_contract: 'proof',
		budget_usd: null,
		ttl_seconds: null,
		cost_usd: 0,
		inference_usd: 0,
		exit_reason: exitReason,
		artifacts_prefix: null,
		created_at: endedAt - 1000,
		started_at: endedAt - 900,
		ended_at: endedAt,
		instance_type: null,
		last_working_event_at: null,
		restart_count: 0,
		...partial,
	}
}

describe('routeHealth', () => {
	it('flags a route unavailable after 3 identical api errors', () => {
		const agents = [
			ended('harness api_error 429', NOW - 300),
			ended('harness api_error 429', NOW - 200),
			ended('harness api_error 429: rate limited', NOW - 100),
		]
		expect(routeHealth(agents, 'claude')).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: '429',
			last_error: 'harness api_error 429: rate limited',
			since: NOW - 300,
		})
	})

	it('stays available below the threshold', () => {
		const agents = [ended('harness api_error 401', NOW - 200), ended('harness api_error 401', NOW)]
		const h = routeHealth(agents, 'claude')
		expect(h.unavailable).toBe(false)
		expect(h.consecutive_api_errors).toBe(2)
		expect(h.api_error_status).toBe('401')
	})

	it('a success after errors resets the streak', () => {
		const agents = [
			ended('harness api_error 429', NOW - 400),
			ended('harness api_error 429', NOW - 300),
			ended('harness api_error 429', NOW - 200),
			ended('completed', NOW - 100),
		]
		expect(routeHealth(agents, 'claude')).toEqual({
			unavailable: false,
			consecutive_api_errors: 0,
			api_error_status: null,
			last_error: null,
			since: null,
		})
	})

	it('a non-api failure or a different status breaks the streak', () => {
		const other = [
			ended('harness api_error 429', NOW - 400),
			ended('runner_restarted', NOW - 300),
			ended('harness api_error 429', NOW - 200),
			ended('harness api_error 429', NOW - 100),
		]
		expect(routeHealth(other, 'claude').consecutive_api_errors).toBe(2)
		const mixed = [
			ended('harness api_error 429', NOW - 300),
			ended('harness api_error spend_cap', NOW - 200),
			ended('harness api_error spend_cap', NOW - 100),
		]
		const h = routeHealth(mixed, 'claude')
		expect(h.unavailable).toBe(false)
		expect(h.consecutive_api_errors).toBe(2)
		expect(h.api_error_status).toBe('spend_cap')
		expect(h.since).toBe(NOW - 200)
	})

	it('orders by ended_at, ignores running agents and other routes', () => {
		const agents = [
			ended('harness api_error 429', NOW - 100),
			ended('completed', NOW - 400),
			ended('harness api_error 429', NOW - 300),
			ended('', NOW, { status: 'running', ended_at: null, exit_reason: null }),
			ended('completed', NOW - 50, { route: 'codex' }),
			ended('harness api_error 429', NOW - 200),
		]
		const h = routeHealth(agents, 'claude')
		expect(h.unavailable).toBe(true)
		expect(h.since).toBe(NOW - 300)
		expect(routeHealth(agents, 'codex').consecutive_api_errors).toBe(0)
		expect(routeHealth(agents, 'grok').unavailable).toBe(false)
	})
})

describe('getRoutesHealth', () => {
	beforeAll(async () => {
		await setupFleetSchema()
	})
	beforeEach(async () => {
		await clearFleet()
	})

	async function finish(route: CloudAgentRow['route'], exitReason: string, endedAt: number) {
		const a = await createCloudAgent(env.FERMI_DB, {
			queue: 'q',
			prompt: 'p',
			proofContract: 'c',
			route,
		})
		await updateCloudAgent(env.FERMI_DB, a.id, {
			status: exitReason === 'completed' ? 'done' : 'failed',
			endedAt,
			exitReason,
		})
	}

	it('reports a block per route from D1', async () => {
		for (let i = 1; i <= 3; i++) await finish('codex', 'harness api_error 402', NOW + i)
		await finish('claude', 'harness api_error 429', NOW + 1)
		await finish('claude', 'completed', NOW + 2)
		const routes = await getRoutesHealth(env.FERMI_DB)
		expect(Object.keys(routes).sort()).toEqual(['claude', 'codex', 'grok'])
		expect(routes.codex).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: '402',
			last_error: 'harness api_error 402',
			since: NOW + 1,
		})
		expect(routes.claude.unavailable).toBe(false)
		expect(routes.claude.consecutive_api_errors).toBe(0)
		expect(routes.grok.consecutive_api_errors).toBe(0)
	})
})
