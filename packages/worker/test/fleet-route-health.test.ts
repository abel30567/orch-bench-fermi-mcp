import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import {
	createCloudAgent,
	listRecentEndedAgents,
	routeHealth,
	updateCloudAgent,
} from '../src/lib/fleet-store.ts'
import { clearFleet, setupFleetSchema } from './setup-d1.ts'

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
	it('is healthy with no ended agents', () => {
		expect(routeHealth([], 'claude')).toEqual({
			unavailable: false,
			consecutive_api_errors: 0,
			api_error_status: null,
			last_error: null,
			since: null,
		})
	})

	it('marks unavailable after 3 consecutive same-status api errors', () => {
		const agents = [
			ended('harness api_error 429', 300),
			ended('harness api_error 429', 100),
			ended('completed', 50),
			ended('harness api_error 429', 200),
		]
		expect(routeHealth(agents, 'claude')).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: '429',
			last_error: 'harness api_error 429',
			since: 100,
		})
	})

	it('2 api errors are not enough', () => {
		const h = routeHealth(
			[
				ended('harness api_error 402', 300),
				ended('harness api_error 402', 200),
				ended('completed', 100),
			],
			'claude',
		)
		expect(h.unavailable).toBe(false)
		expect(h.consecutive_api_errors).toBe(2)
		expect(h.api_error_status).toBe('402')
		expect(h.since).toBe(200)
	})

	it('any other outcome resets the streak', () => {
		const agents = [
			ended('completed', 400),
			ended('harness api_error 429', 300),
			ended('harness api_error 429', 200),
			ended('harness api_error 429', 100),
		]
		expect(routeHealth(agents, 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 0,
			api_error_status: null,
			last_error: null,
			since: null,
		})
		const other = [ended('ttl_expired', 400), ...agents.slice(1)]
		expect(routeHealth(other, 'claude').unavailable).toBe(false)
	})

	it('different statuses do not chain', () => {
		const h = routeHealth(
			[
				ended('harness api_error 401', 300),
				ended('harness api_error 429', 200),
				ended('harness api_error 429', 100),
			],
			'claude',
		)
		expect(h).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 1,
			api_error_status: '401',
		})
	})

	it('only counts the requested route and ignores running agents', () => {
		const agents = [
			ended('harness api_error 429', 300, { route: 'codex' }),
			ended('harness api_error 429', 200, { route: 'codex' }),
			ended('harness api_error 429', 100, { route: 'codex' }),
			ended('', 0, { status: 'running', ended_at: null, exit_reason: null, route: 'codex' }),
		]
		expect(routeHealth(agents, 'codex').unavailable).toBe(true)
		expect(routeHealth(agents, 'claude').unavailable).toBe(false)
	})

	it('keeps trailing detail in last_error', () => {
		const reason = 'harness api_error 402 spend cap reached'
		const h = routeHealth(
			[ended(reason, 3), ended('harness api_error 402', 2), ended('harness api_error 402', 1)],
			'claude',
		)
		expect(h).toMatchObject({ unavailable: true, api_error_status: '402', last_error: reason })
	})
})

describe('listRecentEndedAgents + routeHealth (D1)', () => {
	beforeAll(async () => {
		await setupFleetSchema()
	})
	beforeEach(async () => {
		await clearFleet()
	})

	it('flags a route from stored agents', async () => {
		const db = env.FERMI_DB
		for (const [i, route] of (['grok', 'grok', 'grok', 'claude'] as const).entries()) {
			const a = await createCloudAgent(db, {
				id: `ca_d${i}`,
				queue: `agent:ca_d${i}`,
				prompt: 'p',
				proofContract: 'x',
				route,
			})
			await updateCloudAgent(db, a.id, {
				status: 'failed',
				endedAt: 1000 + i,
				exitReason: 'harness api_error 429',
			})
		}
		await createCloudAgent(db, {
			id: 'ca_live',
			queue: 'agent:ca_live',
			prompt: 'p',
			proofContract: 'x',
			route: 'grok',
		})
		const grok = await listRecentEndedAgents(db, 'grok')
		expect(grok.map((a) => a.id)).toEqual(['ca_d2', 'ca_d1', 'ca_d0'])
		expect(routeHealth(grok, 'grok')).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: '429',
			last_error: 'harness api_error 429',
			since: 1000,
		})
		const claude = await listRecentEndedAgents(db, 'claude')
		expect(routeHealth(claude, 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 1,
		})
	})
})
