import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedStatements } from '../../scripts/eval-db.mjs'
import { logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/phone-history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

// eval-seed.mjs runs seedStatements through `wrangler d1 execute --local`; here
// they run against the contract D1, then the real worker is queried over /mcp.
async function seed(f: unknown, now = Date.now()) {
	const db = env.FERMI_DB
	await db.batch(seedStatements(f, now).map((s: string) => db.prepare(s)))
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

describe('eval seed: conversation history', () => {
	beforeEach(() => resetTables('messages', 'sessions'))

	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		const seededAt = Date.now()
		await seed(fixture)
		const client = await session()
		const args = { channel: fixture.channel, chat_id: fixture.chat_id }

		const ctx = resultJson<{ history: Turn[] }>(await client.callTool('context_bootstrap', args))
		expectSeededTurns(ctx.history, seededAt)

		const hist = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', args),
		)
		expect(hist.total).toBe(5)
		expectSeededTurns(hist.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seed(fixture)
		const client = await session()
		const res = resultJson<{ results: { role: string; body: string }[]; total: number }>(
			await client.callTool('session_search', { query: '"confirm before you dial"' }),
		)
		expect(res.total).toBe(1)
		expect(res.results[0]).toMatchObject({
			role: 'user',
			body: 'Yes, always confirm before you dial.',
		})
	})

	it('a live turn after seeding lands in the seeded session, after the seeded turns', async () => {
		await seed(fixture)
		await logChannelMessage(env.FERMI_DB, 'tg', fixture.chat_id, 'assistant', 'Dialing again.')
		const sessions = await env.FERMI_DB.prepare('SELECT host, mode FROM sessions').all()
		expect(sessions.results).toEqual([{ host: `tg:${fixture.chat_id}`, mode: 'chat' }])
		const client = await session()
		const hist = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel: 'tg', chat_id: fixture.chat_id }),
		)
		expect(hist.messages.map((m) => m.body).at(-1)).toBe('Dialing again.')
		expect(hist.messages).toHaveLength(6)
	})

	it('re-seeding replaces the chat history and leaves other chats alone', async () => {
		await logChannelMessage(env.FERMI_DB, 'tg', 'other-chat', 'user', 'unrelated')
		await seed(fixture)
		await seed(fixture)
		const client = await session()
		const hist = resultJson<{ total: number }>(
			await client.callTool('conversation_history', { channel: 'tg', chat_id: fixture.chat_id }),
		)
		expect(hist.total).toBe(5)
		const other = resultJson<{ total: number }>(
			await client.callTool('conversation_history', { channel: 'tg', chat_id: 'other-chat' }),
		)
		expect(other.total).toBe(1)
	})

	it('prefixes user turns with the sender attribution when sender is given', async () => {
		await seed({
			channel: 'sl',
			chat_id: 'C0EVAL',
			sender: 'Eval Owner',
			history: [
				{ role: 'user', text: 'hi', minutes_ago: 2 },
				{ role: 'assistant', text: 'hello', minutes_ago: 1 },
			],
		})
		const client = await session()
		const hist = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel: 'sl', chat_id: 'C0EVAL' }),
		)
		expect(hist.messages.map((m) => m.body)).toEqual(['[Eval Owner] hi', 'hello'])
	})

	it('rejects history without a channel chat or with a bad turn', () => {
		const history = [{ role: 'user', text: 'x', minutes_ago: 1 }]
		expect(() => seedStatements({ history })).toThrow(/channel/)
		expect(() => seedStatements({ channel: 'tg', history })).toThrow(/chat_id/)
		expect(() =>
			seedStatements({ channel: 'tg', chat_id: 'c', history: [{ role: 'system', text: 'x' }] }),
		).toThrow(/role/)
		expect(() =>
			seedStatements({ channel: 'tg', chat_id: 'c', history: [{ role: 'user', text: 'x' }] }),
		).toThrow(/minutes_ago/)
	})
})
