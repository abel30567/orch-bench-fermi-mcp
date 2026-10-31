import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../../scripts/eval-db.mjs'
import { getConversationHistory, logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

const MINUTE = 60_000
const db = () => env.FERMI_DB

// eval-seed.mjs writes these same statements with `wrangler d1 execute`.
async function seed(input: unknown, now = Date.now()): Promise<void> {
	await db().batch(seedStatements(input, now).map((s: string) => db().prepare(s)))
}

async function dump(now?: number) {
	const sets = await db().batch(Object.values(DUMP_QUERIES).map((q) => db().prepare(q as string)))
	return shapeDump(
		sets.map((s) => s.results),
		now,
	)
}

function expectSeededTurns(turns: Turn[], now: number): void {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, body: text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = now - fixture.history[i].minutes_ago * MINUTE
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(MINUTE)
	}
}

beforeEach(() => resetTables('messages', 'plans', 'team_spawns', 'sessions'))

describe('eval seed: conversation history', () => {
	it('context_bootstrap and conversation_history return the turns in order', async () => {
		const now = Date.now()
		await seed(fixture, now)
		const client = await session()
		const target = { channel: fixture.channel, chat_id: fixture.chat_id }

		const ctx = resultJson<{ history: Turn[] }>(await client.callTool('context_bootstrap', target))
		expectSeededTurns(ctx.history, now)

		const log = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', target),
		)
		expect(log.total).toBe(5)
		expectSeededTurns(log.messages, now)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seed(fixture)
		const client = await session()
		const res = resultJson<{ results: Turn[]; total: number }>(
			await client.callTool('session_search', { query: '"tangerine clinic"' }),
		)
		expect(res).toMatchObject({
			total: 1,
			results: [{ role: 'user', body: 'Try the tangerine clinic line later.' }],
		})
	})

	it('round-trips through the eval-dump queries', async () => {
		const now = Date.now()
		await seed(fixture, now)
		const { history } = await dump(now)
		expect(history).toEqual(
			fixture.history.map((t) => ({
				channel: 'tg',
				chat_id: '1000001',
				role: t.role,
				text: t.text,
				minutes_ago: t.minutes_ago,
				created_at: now - t.minutes_ago * MINUTE,
			})),
		)
	})

	it('dumps channel history only', async () => {
		await seed(fixture)
		await db().batch([
			db().prepare(
				"INSERT INTO sessions (id, host, mode, started_at) VALUES ('other', 'claude-desktop', 'chat', 1)",
			),
			db().prepare(
				"INSERT INTO messages (session_id, role, body, created_at) VALUES ('other', 'user', 'x', 1)",
			),
		])
		expect((await dump()).history).toHaveLength(5)
	})

	it('writes the same rows as logChannelMessage, apart from time and ids', async () => {
		const rows = async () => {
			const sessionRow = await db().prepare('SELECT * FROM sessions').first()
			const message = await db().prepare('SELECT * FROM messages').first()
			const fts = await db()
				.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?1')
				.bind('same')
				.all()
			return {
				session: { ...sessionRow, id: 'x', started_at: 0 },
				message: { ...message, id: 0, session_id: 'x', created_at: 0 },
				indexed: fts.results.length,
			}
		}
		await logChannelMessage(db(), 'tg', 'parity', 'user', 'same body')
		const real = await rows()
		await resetTables('messages', 'sessions')
		await seed({
			channel: 'tg',
			chat_id: 'parity',
			history: [{ role: 'user', text: 'same body', minutes_ago: 3 }],
		})
		expect(real.indexed).toBe(1)
		expect(await rows()).toEqual(real)
	})

	it('later turns land in the seeded session, as with a logged conversation', async () => {
		await seed(fixture)
		await logChannelMessage(db(), 'tg', '1000001', 'user', 'calling back now')
		const sessions = await db().prepare('SELECT id FROM sessions').all()
		expect(sessions.results).toHaveLength(1)
		const { messages } = await getConversationHistory(db(), 'tg', '1000001')
		expect(messages).toHaveLength(6)
		expect(messages.at(-1)?.body).toBe('calling back now')
	})

	it('re-seeding leaves exactly the fixture, even with rows that reference sessions', async () => {
		await seed(fixture)
		const { id } = (await db().prepare('SELECT id FROM sessions').first()) as { id: string }
		await db().batch([
			db()
				.prepare("INSERT INTO plans (id, session_id, steps_json) VALUES ('p', ?1, '[]')")
				.bind(id),
			db()
				.prepare("INSERT INTO team_spawns (id, parent_session, role) VALUES ('t', ?1, 'r')")
				.bind(id),
		])
		await seed(fixture)
		expect((await dump()).history).toHaveLength(5)
	})

	it('stores text with quotes and semicolons verbatim', async () => {
		const text = `it's; "quoted"\nsecond line`
		await seed({
			channel: 'sl',
			chat_id: 'C0EVAL',
			history: [{ role: 'user', text, minutes_ago: 1 }],
		})
		const { messages } = await getConversationHistory(db(), 'sl', 'C0EVAL')
		expect(messages[0].body).toBe(text)
	})

	it('orders turns by time when the fixture does not, with ids to match', async () => {
		await seed({
			channel: 'tg',
			chat_id: 'c',
			history: [
				{ role: 'assistant', text: 'newer', minutes_ago: 1 },
				{ role: 'user', text: 'older', minutes_ago: 9 },
			],
		})
		const { results } = await db().prepare('SELECT body FROM messages ORDER BY id').all()
		expect(results).toEqual([{ body: 'older' }, { body: 'newer' }])
		const started = await db().prepare('SELECT started_at AS t FROM sessions').first('t')
		const first = await db().prepare('SELECT MIN(created_at) AS t FROM messages').first('t')
		expect(started).toBe(first)
	})

	it('attributes user turns to a group sender like the group path, not assistant turns', async () => {
		await seed({
			channel: 'wa',
			chat_id: '123-456@g.us',
			sender: 'Ana',
			history: [
				{ role: 'user', text: 'hello', minutes_ago: 2 },
				{ role: 'assistant', text: 'hi', minutes_ago: 1 },
			],
		})
		const { messages } = await getConversationHistory(db(), 'wa', '123-456@g.us')
		expect(messages.map((m) => m.body)).toEqual(['[Ana] hello', 'hi'])
	})

	const chat = { channel: 'tg', chat_id: 'c' }
	it.each([
		[{ chat_id: 'c', history: [] }, 'channel'],
		[{ channel: 'phone', chat_id: 'c', history: [] }, 'channel'],
		[{ channel: 'tg', history: [] }, 'chat_id'],
		[{ ...chat, history: [{ role: 'system', text: 'x', minutes_ago: 1 }] }, 'role'],
		[{ ...chat, history: [{ role: 'user', text: '', minutes_ago: 1 }] }, 'text'],
		[{ ...chat, history: [{ role: 'user', text: 'x' }] }, 'minutes_ago'],
		[{ ...chat, history: [{ role: 'user', text: 'x', minutes_ago: -1 }] }, 'minutes_ago'],
	])('rejects a malformed history: %j', (input, field) => {
		expect(() => seedStatements(input)).toThrow(field)
	})
})
