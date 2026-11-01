import { describe, expect, it } from 'vitest'
import { parseApiErrorStatus, routeHealth } from '../src/lib/fleet-store.ts'

type A = Parameters<typeof routeHealth>[0][number]
const a = (
	ended_at: number | null,
	exit_reason: string | null,
	status: A['status'] = 'failed',
	route: A['route'] = 'claude',
): A => ({
	route,
	status,
	exit_reason,
	ended_at,
})

describe('routeHealth', () => {
	it('parses api_error statuses', () => {
		expect(parseApiErrorStatus('harness api_error 429')).toBe('429')
		expect(parseApiErrorStatus('harness api_error 401: bad key')).toBe('401')
		expect(parseApiErrorStatus('failed')).toBeNull()
		expect(parseApiErrorStatus(null)).toBeNull()
	})

	it('marks unavailable after 3 same-status api errors', () => {
		const h = routeHealth(
			[
				a(1, 'completed', 'done'),
				a(2, 'harness api_error 429'),
				a(4, 'harness api_error 429'),
				a(3, 'harness api_error 429'),
				a(9, 'harness api_error 429', 'failed', 'codex'),
				a(null, null, 'running'),
			],
			'claude',
		)
		expect(h).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: '429',
			last_error: 'harness api_error 429',
			since: 2,
		})
	})

	it('resets on other outcomes or status change', () => {
		expect(
			routeHealth(
				[a(1, 'harness api_error 429'), a(2, 'harness api_error 429'), a(3, 'completed', 'done')],
				'claude',
			),
		).toEqual({
			unavailable: false,
			consecutive_api_errors: 0,
			api_error_status: null,
			last_error: null,
			since: null,
		})
		const h = routeHealth(
			[a(1, 'harness api_error 429'), a(2, 'harness api_error 401'), a(3, 'harness api_error 401')],
			'claude',
		)
		expect(h.unavailable).toBe(false)
		expect(h.consecutive_api_errors).toBe(2)
		expect(h.api_error_status).toBe('401')
		expect(h.since).toBe(2)
	})
})
