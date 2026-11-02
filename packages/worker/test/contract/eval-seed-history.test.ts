import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedStatements } from '../../scripts/eval-db.mjs'
import fixture from '../fixtures/eval/history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

// eval-seed.mjs runs these statements through `wrangler d1 execute --local`;
// here they run against the contract D1, then the real tools read them over /mcp.

interface Turn {
	role: string
	body: string
	created_at: number
}

const MINUTE = 60_000
const CHAT = { channel: fixture.channel, chat_id: fixture.chat_id }

let seededAt = 0
beforeEach(async () => {
	await resetTables('messages', 'sessions')
	const db = env.FERMI_DB
	await db.batch(seedStatements(fixture).map((s: string) => db.prepare(s)))
	seededAt = Date.now()
})

function expectSeededTurns(turns: Turn[]): void {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, body: text })),
	)
	for (const [i, turn] of fixture.history.entries()) {
		const expected = seededAt - turn.minutes_ago * MINUTE
		expect(Math.abs(turns[i].created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

describe('eval seed: conversation history', () => {
	it('context_bootstrap returns the seeded turns in order with roles and timestamps', async () => {
		const client = await session()
		const ctx = resultJson<{ history: Turn[]; prior_summary: null }>(
			await client.callTool('context_bootstrap', CHAT),
		)
		expect(ctx.prior_summary).toBeNull()
		expectSeededTurns(ctx.history)
	})

	it('conversation_history returns the seeded turns in order with roles and timestamps', async () => {
		const client = await session()
		const res = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', CHAT),
		)
		expect(res.total).toBe(5)
		expectSeededTurns(res.messages)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		const client = await session()
		const res = resultJson<{ results: Array<Turn & { session_id: string }> }>(
			await client.callTool('session_search', { query: '"office line was busy"' }),
		)
		const seeded = await env.FERMI_DB.prepare('SELECT id FROM sessions WHERE host = ?1')
			.bind(`${fixture.channel}:${fixture.chat_id}`)
			.first<{ id: string }>()
		expect(res.results.filter((m) => m.session_id === seeded?.id)).toMatchObject([
			{ role: 'assistant', body: fixture.history[2].text },
		])
	})
})
