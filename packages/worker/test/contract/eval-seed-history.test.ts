import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../../scripts/eval-db.mjs'
import { getOrCreateChannelSession, logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

const { channel, chat_id } = fixture

async function seed(data: unknown, now?: number): Promise<void> {
	await env.FERMI_DB.batch(seedStatements(data, now).map((s) => env.FERMI_DB.prepare(s)))
}

async function dump() {
	const rowSets = []
	for (const query of Object.values(DUMP_QUERIES)) {
		rowSets.push((await env.FERMI_DB.prepare(query).all()).results)
	}
	return shapeDump(rowSets)
}

function expectSeededTurns(turns: Turn[], seededAt: number) {
	expect(turns.map(({ role, body }) => ({ role, text: body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = seededAt - fixture.history[i].minutes_ago * 60_000
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

// eval-seed.mjs feeds these statements to `wrangler d1 execute`; here they run
// on the test worker's D1 and the turns are read back over /mcp.
describe('eval seed: conversation history', () => {
	beforeEach(() => resetTables('messages', 'plans', 'team_spawns', 'sessions'))

	it('returns the turns through context_bootstrap and conversation_history', async () => {
		const seededAt = Date.now()
		await seed(fixture)
		const client = await session()

		const ctx = resultJson<{ history: Turn[] }>(
			await client.callTool('context_bootstrap', { channel, chat_id }),
		)
		expectSeededTurns(ctx.history, seededAt)

		const res = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', { channel, chat_id }),
		)
		expect(res.total).toBe(5)
		expectSeededTurns(res.messages, seededAt)
	})

	it('session_search finds a seeded turn through the FTS trigger', async () => {
		await seed(fixture)
		const client = await session()
		const res = resultJson<{ results: Turn[]; total: number }>(
			await client.callTool('session_search', { query: '"marmalade invoice"' }),
		)
		expect(res).toMatchObject({
			total: 1,
			results: [{ role: 'user', body: fixture.history[4].text }],
		})
	})

	it('round-trips through the eval dump', async () => {
		const now = 1_800_000_000_000
		await seed(fixture, now)
		expect((await dump()).history).toEqual(
			fixture.history.map(({ role, text, minutes_ago }) => ({
				channel,
				chat_id,
				role,
				text,
				created_at: now - minutes_ago * 60_000,
			})),
		)
	})

	it('writes the rows the conversation store writes, and live turns continue the session', async () => {
		await logChannelMessage(env.FERMI_DB, 'tg', 'live', 'user', 'live turn')
		const liveTurn = await env.FERMI_DB.prepare(
			`SELECT s.host, s.mode, s.ended_at, s.summary, m.role FROM messages m
			 JOIN sessions s ON m.session_id = s.id`,
		).first()

		await seed({ channel: 'tg', chat_id: 'live', history: [fixture.history[0]] })
		const seeded = await env.FERMI_DB.prepare(
			`SELECT s.id, s.started_at, s.host, s.mode, s.ended_at, s.summary, m.role, m.created_at
			 FROM messages m JOIN sessions s ON m.session_id = s.id`,
		).first<Record<string, unknown>>()
		expect(seeded).toMatchObject({ ...liveTurn, started_at: seeded?.created_at })

		const sessionId = await getOrCreateChannelSession(env.FERMI_DB, 'tg', 'live')
		expect(sessionId).toBe(seeded?.id)
		await logChannelMessage(env.FERMI_DB, 'tg', 'live', 'assistant', 'reply')
		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel: 'tg', chat_id: 'live' }),
		)
		expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
	})

	it('a re-seed leaves exactly the fixture, even with rows referencing old sessions', async () => {
		await seed({ channel: 'wa', chat_id: 'old', history: [fixture.history[0]] })
		const old = await getOrCreateChannelSession(env.FERMI_DB, 'wa', 'old')
		await env.FERMI_DB.batch([
			env.FERMI_DB.prepare(
				"INSERT INTO plans (id, session_id, steps_json) VALUES ('p', ?1, '[]')",
			).bind(old),
			env.FERMI_DB.prepare(
				"INSERT INTO team_spawns (id, parent_session, role) VALUES ('t', ?1, 'r')",
			).bind(old),
		])

		await seed({
			channel: 'tg',
			chat_id: 'new',
			history: [{ role: 'user', text: 'fresh start', minutes_ago: 1 }],
		})

		expect((await dump()).history.map((t: { text: string }) => t.text)).toEqual(['fresh start'])
		const client = await session()
		const stale = resultJson<{ total: number }>(
			await client.callTool('session_search', { query: 'dentist' }),
		)
		expect(stale.total).toBe(0)
	})

	it('an empty history just clears the conversations', async () => {
		await seed(fixture)
		await seed({ history: [] })
		expect((await dump()).history).toEqual([])
	})

	it('attributes user turns to sender the way group turns are logged', async () => {
		await seed({
			channel: 'dc',
			chat_id: 'group',
			sender: 'Eval Owner',
			history: [
				{ role: 'user', text: 'hello', minutes_ago: 2 },
				{ role: 'assistant', text: 'hi', minutes_ago: 1 },
			],
		})
		expect((await dump()).history.map((t: { text: string }) => t.text)).toEqual([
			'[Eval Owner] hello',
			'hi',
		])
	})

	it('stores turns chronologically whatever the fixture order, keeping ties and quotes', async () => {
		await seed({
			channel: 'tg',
			chat_id: 'order',
			history: [
				{ role: 'assistant', text: "it's newer", minutes_ago: 1 },
				{ role: 'user', text: 'tied first', minutes_ago: 3 },
				{ role: 'assistant', text: 'tied second', minutes_ago: 3 },
			],
		})
		const rows = await env.FERMI_DB.prepare('SELECT body FROM messages ORDER BY id').all()
		expect(rows.results.map((r) => r.body)).toEqual(['tied first', 'tied second', "it's newer"])
	})

	it.each([
		['missing channel', { chat_id: 'c' }],
		['unknown channel', { channel: 'phone', chat_id: 'c' }],
		['missing chat_id', { channel: 'tg' }],
		['non-string sender', { channel: 'tg', chat_id: 'c', sender: 7 }],
	])('rejects %s before writing anything', (_name, base) => {
		const history = [{ role: 'user', text: 'x', minutes_ago: 1 }]
		expect(() => seedStatements({ ...base, history })).toThrow(/history/)
	})

	it.each([
		['bad role', { role: 'system', text: 'x', minutes_ago: 1 }],
		['missing text', { role: 'user', minutes_ago: 1 }],
		['missing minutes_ago', { role: 'user', text: 'x' }],
		['future turn', { role: 'user', text: 'x', minutes_ago: -1 }],
	])('rejects a turn with %s', (_name, turn) => {
		expect(() => seedStatements({ channel: 'tg', chat_id: 'c', history: [turn] })).toThrow(
			/invalid history turn/,
		)
	})
})
