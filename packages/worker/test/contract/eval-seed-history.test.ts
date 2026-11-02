import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedStatements } from '../../scripts/eval-db.mjs'
import fixture from '../fixtures/eval/phone-redial.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

const MINUTE_MS = 60_000

// eval-seed.mjs runs these statements through `wrangler d1 execute --local`;
// here they run against the contract worker's D1, then the real tools read them.
async function seedHistory(): Promise<number> {
	const seededAt = Date.now()
	await env.FERMI_DB.batch(seedStatements(fixture).map((s: string) => env.FERMI_DB.prepare(s)))
	return seededAt
}

function expectSeededTurns(turns: Turn[], seededAt: number) {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map((t) => ({ role: t.role, body: t.text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = seededAt - fixture.history[i].minutes_ago * MINUTE_MS
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

describe('eval seed: conversation history', () => {
	beforeEach(() => resetTables('messages', 'sessions', 'memory', 'profile_docs'))

	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		const seededAt = await seedHistory()
		const client = await session()
		const chat = { channel: fixture.channel, chat_id: fixture.chat_id }

		const ctx = resultJson<{ history: Turn[]; prior_summary: null }>(
			await client.callTool('context_bootstrap', chat),
		)
		expect(ctx.prior_summary).toBeNull()
		expectSeededTurns(ctx.history, seededAt)

		const hist = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', chat),
		)
		expect(hist.total).toBe(fixture.history.length)
		expectSeededTurns(hist.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seedHistory()
		const client = await session()
		const res = resultJson<{ results: Array<{ role: string; body: string }>; total: number }>(
			await client.callTool('session_search', { query: '"line dropped"' }),
		)
		expect(res).toMatchObject({
			total: 1,
			results: [{ role: 'assistant', body: fixture.history[3].text }],
		})
	})
})
