import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedStatements } from '../../scripts/eval-db.mjs'
import { getOrCreateChannelSession, logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/phone-redial.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

const { channel, chat_id, sender, history } = fixture

// eval-seed.mjs runs these statements through `wrangler d1 execute --local`
// against the eval worker's D1; here they run against the contract worker's D1
// and are read back through the real tools over /mcp.
async function seedHistory(): Promise<number> {
	const now = Date.now()
	const db = env.FERMI_DB
	await db.batch(
		seedStatements({ channel, chat_id, sender, history }, now).map((s: string) => db.prepare(s)),
	)
	return now
}

function expectSeededTurns(turns: Turn[], seededAt: number): void {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		history.map(({ role, text }) => ({ role, body: text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = seededAt - history[i].minutes_ago * 60_000
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

describe('eval seed: conversation history', () => {
	beforeEach(() => resetTables('messages', 'sessions'))

	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		const seededAt = await seedHistory()
		const client = await session()

		const ctx = resultJson<{ history: Turn[] }>(
			await client.callTool('context_bootstrap', { channel, chat_id }),
		)
		expectSeededTurns(ctx.history, seededAt)

		const res = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', { channel, chat_id }),
		)
		expect(res.total).toBe(history.length)
		expectSeededTurns(res.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seedHistory()
		const client = await session()
		const res = resultJson<{ results: Array<{ role: string; body: string }> }>(
			await client.callTool('session_search', { query: '"rescheduled cleaning"' }),
		)
		expect(res.results).toContainEqual(
			expect.objectContaining({ role: 'user', body: history[4].text }),
		)
	})

	it('a live turn after seeding continues the seeded conversation', async () => {
		await seedHistory()
		const before = await getOrCreateChannelSession(env.FERMI_DB, channel, chat_id)
		await logChannelMessage(env.FERMI_DB, channel, chat_id, 'user', 'Any luck?')
		expect(await getOrCreateChannelSession(env.FERMI_DB, channel, chat_id)).toBe(before)

		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel, chat_id }),
		)
		expect(res.messages.map((m) => m.body)).toEqual([...history.map((t) => t.text), 'Any luck?'])
	})
})
