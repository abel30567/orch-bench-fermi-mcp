import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedStatements } from '../../scripts/eval-db.mjs'
import { getOrCreateChannelSession, logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/phone-history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

// eval-seed.mjs runs these statements through `wrangler d1 execute --local`
// against the eval worker; here they run against the contract worker's D1 and
// the history is read back over /mcp, as the eval daemon reads it.
interface Turn {
	role: string
	body: string
	created_at: number
}

const MINUTE = 60_000

async function seed(f: unknown, now = Date.now()) {
	const db = env.FERMI_DB
	await db.batch(seedStatements(f, now).map((s: string) => db.prepare(s)))
}

function expectSeededTurns(turns: Turn[], seededAt: number) {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, body: text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = seededAt - fixture.history[i].minutes_ago * MINUTE
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

describe('eval seed: conversation history', () => {
	beforeEach(() => resetTables('messages', 'sessions', 'tasks', 'allowlist', 'profile_docs'))

	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		const seededAt = Date.now()
		await seed(fixture, seededAt)
		const client = await session()
		const chat = { channel: fixture.channel, chat_id: fixture.chat_id }

		const boot = resultJson<{ history: Turn[] }>(await client.callTool('context_bootstrap', chat))
		expectSeededTurns(boot.history, seededAt)

		const history = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', chat),
		)
		expect(history.total).toBe(5)
		expectSeededTurns(history.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seed(fixture)
		const client = await session()
		const res = resultJson<{ results: Turn[]; total: number }>(
			await client.callTool('session_search', { query: '"went to voicemail"' }),
		)
		expect(res.total).toBe(1)
		expect(res.results[0]).toMatchObject({ role: 'assistant', body: fixture.history[2].text })
	})

	it('seeds the same session the conversation store logs live turns into', async () => {
		await seed(fixture)
		const seeded = await env.FERMI_DB.prepare('SELECT id, mode, ended_at FROM sessions').all()
		expect(seeded.results).toEqual([expect.objectContaining({ mode: 'chat', ended_at: null })])
		expect(await getOrCreateChannelSession(env.FERMI_DB, fixture.channel, fixture.chat_id)).toBe(
			seeded.results[0].id,
		)

		await logChannelMessage(env.FERMI_DB, fixture.channel, fixture.chat_id, 'user', 'live turn')
		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expect(res.messages.map((m) => m.body)).toEqual([
			...fixture.history.map((t) => t.text),
			'live turn',
		])
	})

	it('sender attributes user turns like a group chat', async () => {
		await seed({
			channel: 'sl',
			chat_id: 'C0GROUP',
			sender: 'Eval Owner',
			history: [
				{ role: 'user', text: 'who is on call?', minutes_ago: 2 },
				{ role: 'assistant', text: 'Checking.', minutes_ago: 1 },
			],
		})
		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel: 'sl', chat_id: 'C0GROUP' }),
		)
		expect(res.messages.map(({ role, body }) => ({ role, body }))).toEqual([
			{ role: 'user', body: '[Eval Owner] who is on call?' },
			{ role: 'assistant', body: 'Checking.' },
		])
	})

	it('re-seeding replaces the chat history and leaves other chats alone', async () => {
		await logChannelMessage(env.FERMI_DB, 'tg', 'other-chat', 'user', 'keep me')
		await seed(fixture)
		await seed(fixture)
		const client = await session()
		const seeded = resultJson<{ total: number }>(
			await client.callTool('conversation_history', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expect(seeded.total).toBe(5)
		const other = resultJson<{ total: number }>(
			await client.callTool('conversation_history', { channel: 'tg', chat_id: 'other-chat' }),
		)
		expect(other.total).toBe(1)
	})

	it('rejects history without a channel chat or with a bad turn', () => {
		const history = [{ role: 'user', text: 'hi', minutes_ago: 1 }]
		expect(() => seedStatements({ history })).toThrow('channel')
		expect(() => seedStatements({ channel: 'tg', history })).toThrow('chat_id')
		expect(() =>
			seedStatements({ channel: 'tg', chat_id: '1', history: [{ role: 'system', text: 'x' }] }),
		).toThrow('role')
		expect(() =>
			seedStatements({ channel: 'tg', chat_id: '1', history: [{ role: 'user', text: 'x' }] }),
		).toThrow('minutes_ago')
	})
})
