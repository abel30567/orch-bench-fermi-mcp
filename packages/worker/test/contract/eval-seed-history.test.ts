import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedStatements } from '../../scripts/eval-db.mjs'
import { logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/phone-history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

// eval-seed.mjs runs these statements through `wrangler d1 execute --local`
// against the eval worker's D1; here they run against the contract worker's D1,
// and the history is read back over /mcp as the daemon would.
async function seed(f: unknown) {
	const db = env.FERMI_DB
	await db.batch(seedStatements(f).map((s: string) => db.prepare(s)))
}

interface Turn {
	role: string
	body: string
	created_at: number
}

const chat = { channel: fixture.channel, chat_id: fixture.chat_id }

function expectSeededTurns(turns: Turn[]) {
	const now = Date.now()
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, body: text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = now - fixture.history[i].minutes_ago * 60_000
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

describe('eval seed: conversation history', () => {
	beforeEach(() => resetTables('messages', 'sessions'))

	it('context_bootstrap returns the seeded turns in order with roles and timestamps', async () => {
		await seed(fixture)
		const client = await session()
		const res = resultJson<{ history: Turn[] }>(await client.callTool('context_bootstrap', chat))
		expectSeededTurns(res.history)
	})

	it('conversation_history returns the seeded turns in order with roles and timestamps', async () => {
		await seed(fixture)
		const client = await session()
		const res = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', chat),
		)
		expect(res.total).toBe(5)
		expectSeededTurns(res.messages)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seed(fixture)
		const client = await session()
		const res = resultJson<{ results: Array<{ role: string; body: string }>; total: number }>(
			await client.callTool('session_search', { query: '"periwinkle family"' }),
		)
		expect(res.total).toBe(1)
		expect(res.results[0]).toMatchObject({ role: 'user', body: fixture.history[4].text })
	})

	it('live turns logged by the channel code land in the seeded session after it', async () => {
		await seed(fixture)
		await logChannelMessage(env.FERMI_DB, chat.channel, chat.chat_id, 'user', 'Any luck?')
		const sessions = await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE host = ?')
			.bind(`${chat.channel}:${chat.chat_id}`)
			.first<{ n: number }>()
		expect(sessions?.n).toBe(1)
		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', chat),
		)
		expect(res.messages.map((m) => m.body)).toEqual([
			...fixture.history.map((t) => t.text),
			'Any luck?',
		])
	})

	it('prefixes user turns with the sender like a group-chat webhook', async () => {
		await seed({
			channel: 'tg',
			chat_id: '-100200',
			sender: 'Eval Owner',
			history: [
				{ role: 'user', text: 'call the plumber', minutes_ago: 10 },
				{ role: 'assistant', text: 'Shall I dial?', minutes_ago: 9 },
			],
		})
		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel: 'tg', chat_id: '-100200' }),
		)
		expect(res.messages.map(({ role, body }) => ({ role, body }))).toEqual([
			{ role: 'user', body: '[Eval Owner] call the plumber' },
			{ role: 'assistant', body: 'Shall I dial?' },
		])
	})

	it('re-seeding replaces the history, including other chats', async () => {
		await logChannelMessage(env.FERMI_DB, 'tg', 'other-chat', 'user', 'periwinkle elsewhere')
		await seed(fixture)
		await seed(fixture)
		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', chat),
		)
		expect(res.messages).toHaveLength(5)
		const search = resultJson<{ total: number }>(
			await client.callTool('session_search', { query: 'periwinkle' }),
		)
		expect(search.total).toBe(1)
	})

	it('rejects history without the inbound chat or with a malformed turn', () => {
		expect(() => seedStatements({ history: fixture.history })).toThrow(/channel.*chat_id/)
		expect(() =>
			seedStatements({ ...chat, history: [{ role: 'system', text: 'x', minutes_ago: 1 }] }),
		).toThrow(/history\[0\]/)
		expect(() => seedStatements({ ...chat, history: [{ role: 'user', text: 'x' }] })).toThrow(
			/history\[0\]/,
		)
	})
})
