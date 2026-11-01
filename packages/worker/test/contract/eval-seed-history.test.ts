import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedStatements } from '../../scripts/eval-db.mjs'
import fixture from '../fixtures/eval/history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

// eval-seed.mjs runs seedStatements through `wrangler d1 execute --local`; here
// the same statements run against the contract D1 and the real worker answers
// over /mcp.
interface Turn {
	role: string
	body: string
	created_at: number
}

const { channel, chat_id } = fixture

beforeEach(() => resetTables('messages', 'sessions'))

async function seedHistory(now: number) {
	const db = env.FERMI_DB
	await db.batch(seedStatements(fixture, now).map((s: string) => db.prepare(s)))
}

function expectTurns(turns: Turn[], now: number) {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, body: text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = now - fixture.history[i].minutes_ago * 60_000
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

describe('eval seed: conversation history', () => {
	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		const now = Date.now()
		await seedHistory(now)
		const client = await session()

		const ctx = resultJson<{ history: Turn[]; prior_summary: null }>(
			await client.callTool('context_bootstrap', { channel, chat_id }),
		)
		expect(ctx.prior_summary).toBeNull()
		expectTurns(ctx.history, now)

		const hist = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', { channel, chat_id }),
		)
		expect(hist.total).toBe(5)
		expectTurns(hist.messages, now)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seedHistory(Date.now())
		const client = await session()
		const res = resultJson<{ results: Turn[]; total: number }>(
			await client.callTool('session_search', { query: '"line was busy"' }),
		)
		expect(res.total).toBe(1)
		expect(res.results[0]).toMatchObject({
			role: 'assistant',
			body: 'The line was busy, so no appointment yet.',
		})
	})

	it('re-seeding replaces the chat transcript and its search index', async () => {
		await seedHistory(Date.now())
		await seedHistory(Date.now())
		const client = await session()
		const hist = resultJson<{ total: number }>(
			await client.callTool('conversation_history', { channel, chat_id }),
		)
		expect(hist.total).toBe(5)
		const res = resultJson<{ total: number }>(
			await client.callTool('session_search', { query: '"line was busy"' }),
		)
		expect(res.total).toBe(1)
	})
})
