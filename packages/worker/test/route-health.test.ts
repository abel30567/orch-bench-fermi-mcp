import { describe, expect, it } from 'vitest'
import { routeHealth } from '../src/lib/fleet-store.ts'

const a = (
	ended_at: number | null,
	exit_reason: string | null,
	route: 'claude' | 'codex' | 'grok' = 'claude',
) => ({ route, ended_at, exit_reason })

describe('routeHealth', () => {
	it('flags a route after 3 consecutive identical api errors', () => {
		const h = routeHealth(
			[
				a(1, 'done'),
				a(2, 'harness api_error 429'),
				a(3, 'harness api_error 429'),
				a(4, 'harness api_error 429'),
				a(null, null),
				a(5, 'done', 'codex'),
			],
			'claude',
		)
		expect(h).toEqual({
			unavailable: true,
			consecutive_api_errors: 3,
			api_error_status: 429,
			last_error: 'harness api_error 429',
			since: 2,
		})
	})

	it('resets on any other outcome or a different status', () => {
		expect(
			routeHealth(
				[
					a(1, 'harness api_error 429'),
					a(2, 'harness api_error 429'),
					a(3, 'done'),
					a(4, 'harness api_error 401'),
				],
				'claude',
			),
		).toMatchObject({ unavailable: false, consecutive_api_errors: 1, api_error_status: 401 })
		expect(
			routeHealth(
				[
					a(1, 'harness api_error 401'),
					a(2, 'harness api_error 429'),
					a(3, 'harness api_error 429'),
				],
				'claude',
			),
		).toMatchObject({ unavailable: false, consecutive_api_errors: 2 })
		expect(routeHealth([], 'grok')).toEqual({
			unavailable: false,
			consecutive_api_errors: 0,
			api_error_status: null,
			last_error: null,
			since: null,
		})
	})
})
