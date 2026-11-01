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

// eval-seed.mjs runs these statements through `wrangler d1 execute --local`
// against the eval worker's D1; here they run against the contract worker's D1,
// and the transcript is read back over /mcp like the daemon does.
async function seedHistory(): Promise<number> {
	const now = Date.now()
	const db = env.FERMI_DB
	await db.batch(seedStatements(fixture, now).map((s: string) => db.prepare(s)))
	return now
}

function expectSeededTurns(turns: Turn[], seededAt: number): void {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, body: text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = Date.now() - fixture.history[i].minutes_ago * 60_000
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
		expect(turn.created_at).toBe(seededAt - fixture.history[i].minutes_ago * 60_000)
	}
}

describe('eval seed: conversation history via the conversation store', () => {
	beforeEach(() => resetTables('messages', 'sessions'))

	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		const seededAt = await seedHistory()
		const client = await session()
		const chat = { channel: fixture.channel, chat_id: fixture.chat_id }

		const ctx = resultJson<{ history: Turn[] }>(await client.callTool('context_bootstrap', chat))
		expectSeededTurns(ctx.history, seededAt)

		const hist = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', chat),
		)
		expect(hist.total).toBe(5)
		expectSeededTurns(hist.messages, seededAt)
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
