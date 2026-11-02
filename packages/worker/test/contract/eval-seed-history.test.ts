import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedStatements } from '../../scripts/eval-db.mjs'
import fixture from '../fixtures/eval/history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

// eval-seed.mjs runs these statements through `wrangler d1 execute --local`;
// here they run against the contract D1, then the real worker answers over /mcp.
async function seedHistory(): Promise<number> {
	const db = env.FERMI_DB
	await db.batch(seedStatements(fixture).map((s: string) => db.prepare(s)))
	return Date.now()
}

function expectSeededTurns(turns: Turn[], seededAt: number) {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, body: text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = seededAt - fixture.history[i].minutes_ago * 60_000
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

beforeEach(() => resetTables('messages', 'sessions'))

describe('eval seed: conversation history via the conversation store', () => {
	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		expect(fixture.history).toHaveLength(5)
		const seededAt = await seedHistory()
		const client = await session()
		const chat = { channel: fixture.channel, chat_id: fixture.chat_id }

		const ctx = resultJson<{ history: Turn[]; prior_summary: null }>(
			await client.callTool('context_bootstrap', chat),
		)
		expect(ctx.prior_summary).toBeNull()
		expectSeededTurns(ctx.history, seededAt)

		const history = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', chat),
		)
		expect(history.total).toBe(5)
		expectSeededTurns(history.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seedHistory()
		const client = await session()
		const res = resultJson<{ results: Array<{ role: string; body: string }>; total: number }>(
			await client.callTool('session_search', { query: '"line was busy"' }),
		)
		expect(res.total).toBe(1)
		expect(res.results[0]).toMatchObject({ role: 'assistant', body: fixture.history[2].text })
	})
})
