import { describe, expect, it } from 'vitest'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { routeHealth } from '../src/lib/fleet-store.ts'

let n = 0
function ended(route: CloudAgentRow['route'], at: number, exit: string | null, status: CloudAgentRow['status'] = 'failed'): CloudAgentRow {
	n++
	return {
		id: `ca_${n}`, box_id: null, task_id: null, queue: `agent:ca_${n}`, status, route,
		prompt: 'p', proof_contract: 'proof', budget_usd: null, ttl_seconds: null, cost_usd: 0,
		inference_usd: 0, exit_reason: exit, artifacts_prefix: null, created_at: at - 10,
		started_at: at - 5, ended_at: at, instance_type: null, last_working_event_at: null, restart_count: 0,
	}
}

describe('routeHealth', () => {
	it('flags a route after 3 consecutive same-status api errors', () => {
		const agents = [
			ended('claude', 1, 'completed', 'done'),
			ended('claude', 2, 'harness api_error 429'),
			ended('claude', 3, 'harness api_error 429'),
			ended('claude', 4, 'harness api_error 429'),
			ended('codex', 5, 'completed', 'done'),
		]
		expect(routeHealth(agents, 'claude')).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: 429,
			last_error: 'harness api_error 429',
			since: 2,
		})
		expect(routeHealth(agents, 'codex')).toMatchObject({ unavailable: false, consecutive_api_errors: 0 })
	})

	it('resets on any other outcome or differing status', () => {
		const reset = [
			ended('claude', 1, 'harness api_error 429'),
			ended('claude', 2, 'harness api_error 429'),
			ended('claude', 3, 'completed', 'done'),
			ended('claude', 4, 'harness api_error 429'),
			ended('claude', 5, 'harness api_error 429'),
		]
		expect(routeHealth(reset, 'claude')).toMatchObject({ unavailable: false, consecutive_api_errors: 2, since: 4 })
		const mixed = [
			ended('grok', 1, 'harness api_error 401'),
			ended('grok', 2, 'harness api_error 429'),
			ended('grok', 3, 'harness api_error 429'),
		]
		expect(routeHealth(mixed, 'grok')).toMatchObject({ unavailable: false, consecutive_api_errors: 2, api_error_status: 429 })
		expect(routeHealth([], 'grok')).toEqual({
			unavailable: false, consecutive_api_errors: 0, api_error_status: null, last_error: null, since: null,
		})
	})

	it('ignores agents that have not ended', () => {
		const agents = [
			ended('claude', 1, 'harness api_error 402'),
			ended('claude', 2, 'harness api_error 402'),
			ended('claude', 3, 'harness api_error 402'),
			{ ...ended('claude', 4, null, 'running'), ended_at: null },
		]
		expect(routeHealth(agents, 'claude').unavailable).toBe(true)
	})
})
