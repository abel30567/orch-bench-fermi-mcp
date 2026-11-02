import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../scripts/eval-db.mjs'
import { getConversationHistory, logChannelMessage } from '../src/lib/conversation.ts'
import historyFixture from './fixtures/eval/history.json'
import fixture from './fixtures/eval/sample.json'
import { applyMigrations } from './setup-d1.ts'

// eval-seed.mjs / eval-dump.mjs run these same statements through
// `wrangler d1 execute --local`; here they run against the test D1.
async function seed(f: unknown, now?: number) {
	const db = env.FERMI_DB
	await db.batch(seedStatements(f, now).map((s: string) => db.prepare(s)))
}

async function dump() {
	const rowSets = []
	for (const query of Object.values(DUMP_QUERIES)) {
		rowSets.push((await env.FERMI_DB.prepare(query).all()).results)
	}
	return shapeDump(rowSets)
}

describe('eval seed/dump', () => {
	beforeAll(async () => {
		await applyMigrations()
	})

	it('round-trips the sample fixture', async () => {
		await seed(fixture)
		const out = await dump()
		// Skills are seeded over MCP (test/contract/eval-seed-skills.test.ts).
		const { skills: _skills, ...d1Fixture } = fixture
		expect(out).toMatchObject(d1Fixture)
		expect(out.tasks[0].status).toBe('pending')
		expect(Object.keys(out)).toEqual([
			'profile',
			'memories',
			'allowlist',
			'tasks',
			'outbox',
			'schedules',
			'skills',
			'audit',
			'history',
		])
	})

	it('re-seeding replaces rows instead of appending, including migration-seeded ones', async () => {
		await seed(fixture)
		await seed(fixture)
		const out = await dump()
		expect(out.memories).toHaveLength(fixture.memories.length)
		expect(out.allowlist).toEqual(fixture.allowlist)
	})

	it('escapes quotes in values', async () => {
		await seed({ memories: [{ kind: 'fact', body: "it's '; DROP TABLE memory; --" }] })
		expect((await dump()).memories.map((m: { body: string }) => m.body)).toEqual([
			"it's '; DROP TABLE memory; --",
		])
	})
})

describe('eval seed/dump: conversation history', () => {
	const NOW = 1_800_000_000_000

	beforeAll(async () => {
		await applyMigrations()
	})

	it('round-trips the history fixture through the dump, timestamped from minutes_ago', async () => {
		await seed(historyFixture, NOW)
		const out = await dump()
		expect(out.history).toEqual(
			historyFixture.history.map((t) => ({
				channel: 'tg',
				chat_id: '1000001',
				role: t.role,
				text: t.text,
				created_at: NOW - t.minutes_ago * 60_000,
			})),
		)
		expect(out.tasks.map((t: { id: string }) => t.id)).toEqual(['eval-task-redial'])
	})

	it('writes the same session and message rows as logChannelMessage', async () => {
		await seed({ channel: 'sl', chat_id: 'C0REF', history: [] })
		await logChannelMessage(env.FERMI_DB, 'sl', 'C0REF', 'user', 'from the gateway')
		await logChannelMessage(env.FERMI_DB, 'sl', 'C0REF', 'assistant', 'from channel_send')
		const rows = async (host: string) => {
			const sessions = await env.FERMI_DB.prepare(
				'SELECT host, mode, ended_at, summary FROM sessions WHERE host = ?1',
			)
				.bind(host)
				.all()
			const messages = await env.FERMI_DB.prepare(
				`SELECT m.role, typeof(m.created_at) AS ts_type, typeof(m.id) AS id_type
				   FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.host = ?1
				  ORDER BY m.id`,
			)
				.bind(host)
				.all()
			return { sessions: sessions.results, messages: messages.results }
		}
		const real = await rows('sl:C0REF')

		await seed({
			channel: 'sl',
			chat_id: 'C0SEED',
			history: [
				{ role: 'user', text: 'a', minutes_ago: 2 },
				{ role: 'assistant', text: 'b', minutes_ago: 1 },
			],
		})
		const seeded = await rows('sl:C0SEED')
		expect(seeded.sessions.map((s) => ({ ...s, host: 'sl:C0REF' }))).toEqual(real.sessions)
		expect(seeded.messages).toEqual(real.messages)

		// The production read path sees the seeded chat like a logged one, and a
		// later logged turn lands in the seeded (still open) session.
		await logChannelMessage(env.FERMI_DB, 'sl', 'C0SEED', 'user', 'c')
		const history = await getConversationHistory(env.FERMI_DB, 'sl', 'C0SEED')
		expect(history.messages.map((m) => [m.role, m.body])).toEqual([
			['user', 'a'],
			['assistant', 'b'],
			['user', 'c'],
		])
		const { n } = (await env.FERMI_DB.prepare(
			"SELECT count(*) AS n FROM sessions WHERE host = 'sl:C0SEED'",
		).first<{ n: number }>()) ?? { n: 0 }
		expect(n).toBe(1)
	})

	it('re-seeding replaces the history and the chat sessions instead of appending', async () => {
		await seed(historyFixture, NOW)
		await env.FERMI_DB.prepare(
			"UPDATE sessions SET ended_at = 1, summary = 'stale' WHERE host = 'tg:1000001'",
		).run()
		await seed(historyFixture, NOW)
		const out = await dump()
		expect(out.history).toHaveLength(historyFixture.history.length)
		const history = await getConversationHistory(env.FERMI_DB, 'tg', '1000001')
		expect(history.prior_summary).toBeNull()
		const { n } = (await env.FERMI_DB.prepare(
			"SELECT count(*) AS n FROM sessions WHERE host = 'tg:1000001'",
		).first<{ n: number }>()) ?? { n: 0 }
		expect(n).toBe(1)
	})

	it('keeps fixture order for turns with the same minutes_ago and escapes quotes', async () => {
		await seed(
			{
				channel: 'wa',
				chat_id: "it's",
				history: [
					{ role: 'user', text: "don't '; DROP TABLE messages; --", minutes_ago: 5 },
					{ role: 'assistant', text: 'second', minutes_ago: 5 },
				],
			},
			NOW,
		)
		expect((await dump()).history).toEqual([
			{
				channel: 'wa',
				chat_id: "it's",
				role: 'user',
				text: "don't '; DROP TABLE messages; --",
				created_at: NOW - 300_000,
			},
			{
				channel: 'wa',
				chat_id: "it's",
				role: 'assistant',
				text: 'second',
				created_at: NOW - 300_000,
			},
		])
	})

	it.each([
		[{ history: [] }, /channel/],
		[{ channel: 'xx', chat_id: 'c', history: [] }, /channel/],
		[{ channel: 'tg', history: [] }, /chat_id/],
		[{ channel: 'tg', chat_id: 'c', sender: 1, history: [] }, /sender/],
		[
			{ channel: 'tg', chat_id: 'c', history: [{ role: 'system', text: 'x', minutes_ago: 1 }] },
			/role/,
		],
		[{ channel: 'tg', chat_id: 'c', history: [{ role: 'user', minutes_ago: 1 }] }, /text/],
		[{ channel: 'tg', chat_id: 'c', history: [{ role: 'user', text: 'x' }] }, /minutes_ago/],
		[
			{ channel: 'tg', chat_id: 'c', history: [{ role: 'user', text: 'x', minutes_ago: -1 }] },
			/minutes_ago/,
		],
	])('rejects an invalid history fixture %j', (f, error) => {
		expect(() => seedStatements(f)).toThrow(error)
	})
})
