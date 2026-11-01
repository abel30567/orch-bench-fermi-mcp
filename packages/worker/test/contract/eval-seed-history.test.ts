import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedStatements } from '../../scripts/eval-db.mjs'
import fixture from '../fixtures/eval/phone-history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

// eval-seed.mjs runs these statements through `wrangler d1 execute --local`;
// here they run against the contract D1, then the real tools read them over /mcp.

interface Turn {
	role: string
	body: string
	created_at: number
}

const expected = fixture.history.map((t) => ({
	role: t.role,
	body: t.role === 'user' ? `[${fixture.sender}] ${t.text}` : t.text,
	minutes_ago: t.minutes_ago,
}))

function expectTurns(turns: Turn[], seededAt: number) {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		expected.map(({ role, body }) => ({ role, body })),
	)
	for (const [i, turn] of turns.entries()) {
		const want = seededAt - expected[i].minutes_ago * 60_000
		expect(Math.abs(turn.created_at - want)).toBeLessThanOrEqual(60_000)
	}
}

describe('eval seed: conversation history', () => {
	let seededAt: number

	beforeEach(async () => {
		await resetTables('messages', 'sessions')
		seededAt = Date.now()
		const db = env.FERMI_DB
		await db.batch(seedStatements(fixture).map((s: string) => db.prepare(s)))
	})

	it('context_bootstrap and conversation_history return the seeded turns', async () => {
		const client = await session()
		const args = { channel: fixture.channel, chat_id: fixture.chat_id }
		const boot = resultJson<{ history: Turn[] }>(await client.callTool('context_bootstrap', args))
		expectTurns(boot.history, seededAt)
		const hist = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', args),
		)
		expect(hist.total).toBe(5)
		expectTurns(hist.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		const client = await session()
		const res = resultJson<{ results: Array<{ role: string; body: string }> }>(
			await client.callTool('session_search', { query: '"line dropped"' }),
		)
		expect(res.results).toEqual([
			expect.objectContaining({ role: 'assistant', body: fixture.history[3].text }),
		])
	})
})
