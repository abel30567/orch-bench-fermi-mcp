import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedStatements } from '../../scripts/eval-db.mjs'
import { getOrCreateChannelSession, logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/phone-history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

// eval-seed.mjs runs these statements through `wrangler d1 execute --local`
// against the eval worker's D1; here they run against the real worker's D1 and
// the turns are read back over /mcp, as the daemon reads them.
async function seed(f: unknown): Promise<number> {
	const seededAt = Date.now()
	const db = env.FERMI_DB
	await db.batch(seedStatements(f, seededAt).map((s: string) => db.prepare(s)))
	return seededAt
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

beforeEach(() => resetTables('messages', 'sessions', 'tasks', 'allowlist', 'profile_docs'))

describe('eval seed: conversation history', () => {
	it('context_bootstrap returns the seeded turns in order with roles and timestamps', async () => {
		const seededAt = await seed(fixture)
		const client = await session()
		const ctx = resultJson<{ history: Turn[] }>(
			await client.callTool('context_bootstrap', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expect(ctx.history).toHaveLength(5)
		expectSeededTurns(ctx.history, seededAt)
	})

	it('conversation_history returns the seeded turns in order with roles and timestamps', async () => {
		const seededAt = await seed(fixture)
		const client = await session()
		const res = resultJson<{ messages: Turn[]; total: number; prior_summary: null }>(
			await client.callTool('conversation_history', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expect(res).toMatchObject({ total: 5, prior_summary: null })
		expectSeededTurns(res.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seed(fixture)
		const client = await session()
		const res = resultJson<{ results: Array<Turn & { session_id: string }>; total: number }>(
			await client.callTool('session_search', { query: '"line was busy"' }),
		)
		expect(res.total).toBe(1)
		expect(res.results[0]).toMatchObject({ role: 'assistant', body: fixture.history[3].text })
		const sessionId = await getOrCreateChannelSession(
			env.FERMI_DB,
			fixture.channel,
			fixture.chat_id,
		)
		expect(res.results[0].session_id).toBe(sessionId)
	})

	it('a live turn logged afterwards joins the seeded conversation', async () => {
		await seed(fixture)
		await logChannelMessage(env.FERMI_DB, 'tg', fixture.chat_id, 'user', fixture.tasks[0].payload)
		const sessions = await env.FERMI_DB.prepare(
			'SELECT mode, ended_at FROM sessions WHERE host = ?',
		)
			.bind(`tg:${fixture.chat_id}`)
			.all()
		expect(sessions.results).toEqual([{ mode: 'chat', ended_at: null }])

		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel: 'tg', chat_id: fixture.chat_id }),
		)
		expect(res.messages.map((m) => m.body)).toEqual([
			...fixture.history.map((t) => t.text),
			fixture.tasks[0].payload,
		])
	})

	it('re-seeding replaces the chat history instead of appending, leaving other chats alone', async () => {
		await logChannelMessage(env.FERMI_DB, 'tg', 'other-chat', 'user', 'unrelated')
		await seed(fixture)
		const seededAt = await seed(fixture)
		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel: 'tg', chat_id: fixture.chat_id }),
		)
		expectSeededTurns(res.messages, seededAt)
		const other = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel: 'tg', chat_id: 'other-chat' }),
		)
		expect(other.messages.map((m) => m.body)).toEqual(['unrelated'])
	})
})
