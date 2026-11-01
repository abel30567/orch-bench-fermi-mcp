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
// here they run against the contract D1, then the real tools read them over /mcp.
async function seedHistory(): Promise<number> {
	const now = Date.now()
	const db = env.FERMI_DB
	await db.batch(seedStatements(fixture, now).map((s: string) => db.prepare(s)))
	return now
}

function expectSeededTurns(turns: Turn[], seededAt: number): void {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map((t) => ({ role: t.role, body: t.text })),
	)
	for (const [i, t] of fixture.history.entries()) {
		expect(Math.abs(turns[i].created_at - (seededAt - t.minutes_ago * 60_000))).toBeLessThanOrEqual(
			60_000,
		)
	}
}

describe('eval seed: conversation history', () => {
	beforeEach(() => resetTables('messages', 'sessions'))

	it('context_bootstrap and conversation_history return the seeded turns', async () => {
		const seededAt = await seedHistory()
		const client = await session()
		const args = { channel: fixture.channel, chat_id: fixture.chat_id }

		const ctx = resultJson<{ history: Turn[] }>(await client.callTool('context_bootstrap', args))
		expectSeededTurns(ctx.history, seededAt)

		const history = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', args),
		)
		expect(history.total).toBe(5)
		expectSeededTurns(history.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seedHistory()
		const client = await session()
		const res = resultJson<{ results: Array<{ role: string; body: string }> }>(
			await client.callTool('session_search', { query: '"line was busy"' }),
		)
		expect(res.results.map(({ role, body }) => ({ role, body }))).toEqual([
			{ role: 'assistant', body: fixture.history[2].text },
		])
	})
})
