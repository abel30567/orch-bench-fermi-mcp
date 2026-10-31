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

const NOW = 1_800_000_000_000

let seq = 0
function ended(
	endedAt: number,
	exitReason: string,
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
	it('flags a route whose 3 most recent agents failed with the same api_error', () => {
		const agents = [
			ended(NOW + 3, 'harness api_error 429'),
			ended(NOW + 1, 'harness api_error 429'),
			ended(NOW + 2, 'harness api_error 429: rate limited'),
			ended(NOW, 'completed'),
		]
		expect(routeHealth(agents, 'claude')).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: '429',
			last_error: 'harness api_error 429',
			since: NOW + 1,
		})
	})

	it('stays available below the threshold', () => {
		const h = routeHealth(
			[ended(NOW + 2, 'harness api_error 402'), ended(NOW + 1, 'harness api_error 402')],
			'claude',
		)
		expect(h).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 2,
			api_error_status: '402',
		})
	})

	it('any other outcome resets the streak', () => {
		const agents = [
			ended(NOW + 4, 'completed'),
			ended(NOW + 3, 'harness api_error 429'),
			ended(NOW + 2, 'harness api_error 429'),
			ended(NOW + 1, 'harness api_error 429'),
		]
		expect(routeHealth(agents, 'claude')).toEqual({
			unavailable: false,
			consecutive_api_errors: 0,
			api_error_status: null,
			last_error: null,
			since: null,
		})
		const nonApiFail = [ended(NOW + 4, 'ttl_expired'), ...agents.slice(1)]
		expect(routeHealth(nonApiFail, 'claude').consecutive_api_errors).toBe(0)
	})

	it('a different api_error status breaks the streak', () => {
		const agents = [
			ended(NOW + 3, 'harness api_error 401'),
			ended(NOW + 2, 'harness api_error 429'),
			ended(NOW + 1, 'harness api_error 429'),
		]
		expect(routeHealth(agents, 'claude')).toMatchObject({
			unavailable: false,
			consecutive_api_errors: 1,
			api_error_status: '401',
		})
	})

	it('ignores other routes and agents that have not ended', () => {
		const agents = [
			ended(NOW + 9, 'completed', { route: 'codex' }),
			{ ...ended(NOW + 8, 'harness api_error 429'), status: 'running', ended_at: null },
			ended(NOW + 3, 'harness api_error 429'),
			ended(NOW + 2, 'harness api_error 429'),
			ended(NOW + 1, 'harness api_error 429'),
		] as CloudAgentRow[]
		expect(routeHealth(agents, 'claude').unavailable).toBe(true)
		expect(routeHealth(agents, 'codex').consecutive_api_errors).toBe(0)
		expect(routeHealth(agents, 'grok').unavailable).toBe(false)
	})

	it('api_error text on a non-failed agent does not count', () => {
		const agents = [1, 2, 3].map((i) =>
			ended(NOW + i, 'harness api_error 429', { status: 'destroyed' }),
		)
		expect(routeHealth(agents, 'claude').consecutive_api_errors).toBe(0)
	})
})

describe('listRecentEndedAgents', () => {
	beforeAll(setupFleetSchema)
	beforeEach(clearFleet)

	it('returns only ended agents of the route, newest ended first', async () => {
		const mk = async (id: string, route: CloudAgentRow['route'], endedAt?: number) => {
			await createCloudAgent(env.FERMI_DB, {
				id,
				queue: `agent:${id}`,
				prompt: 'p',
				proofContract: 'x',
				route,
			})
			if (endedAt !== undefined)
				await updateCloudAgent(env.FERMI_DB, id, {
					status: 'failed',
					endedAt,
					exitReason: 'harness api_error 429',
				})
		}
		await mk('a', 'claude', NOW + 1)
		await mk('b', 'claude', NOW + 3)
		await mk('c', 'claude')
		await mk('d', 'codex', NOW + 2)
		await mk('e', 'claude', NOW + 2)
		const rows = await listRecentEndedAgents(env.FERMI_DB, 'claude')
		expect(rows.map((r) => r.id)).toEqual(['b', 'e', 'a'])
		expect(routeHealth(rows, 'claude')).toMatchObject({ unavailable: true, since: NOW + 1 })
	})
})
