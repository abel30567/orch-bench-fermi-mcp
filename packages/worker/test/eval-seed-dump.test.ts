import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../scripts/eval-db.mjs'
import { logChannelMessage } from '../src/lib/conversation.ts'
import historyFixture from './fixtures/eval/history.json'
import fixture from './fixtures/eval/sample.json'
import { applyMigrations } from './setup-d1.ts'

// eval-seed.mjs / eval-dump.mjs run these same statements through
// `wrangler d1 execute --local`; here they run against the test D1.
async function seed(f: unknown) {
	const db = env.FERMI_DB
	await db.batch(seedStatements(f).map((s: string) => db.prepare(s)))
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

	it('round-trips the history fixture with timestamps from minutes_ago', async () => {
		const seededAt = Date.now()
		await seed(historyFixture)
		const out = await dump()
		expect(out.history.map(({ created_at: _t, ...turn }: { created_at: number }) => turn)).toEqual(
			historyFixture.history.map((t) => ({
				channel: historyFixture.channel,
				chat_id: historyFixture.chat_id,
				role: t.role,
				text: t.text,
			})),
		)
		for (const [i, row] of out.history.entries()) {
			const expected = seededAt - historyFixture.history[i].minutes_ago * 60_000
			expect(Math.abs(row.created_at - expected)).toBeLessThanOrEqual(60_000)
		}
	})

	it('writes the same session and message rows as logChannelMessage', async () => {
		await logChannelMessage(env.FERMI_DB, 'tg', 'live-chat', 'user', 'live turn')
		await seed({
			channel: 'tg',
			chat_id: 'seeded-chat',
			history: [{ role: 'user', text: 'seeded turn', minutes_ago: 0 }],
		})
		const rows = await env.FERMI_DB.prepare(
			`SELECT s.host, s.mode, s.ended_at, s.summary, m.role, m.body,
				m.created_at >= s.started_at AS after_start
			 FROM messages m JOIN sessions s ON m.session_id = s.id
			 WHERE s.host IN ('tg:live-chat', 'tg:seeded-chat') ORDER BY s.host`,
		).all()
		const shape = { mode: 'chat', ended_at: null, summary: null, role: 'user', after_start: 1 }
		expect(rows.results).toEqual([
			{ host: 'tg:live-chat', body: 'live turn', ...shape },
			{ host: 'tg:seeded-chat', body: 'seeded turn', ...shape },
		])

		// A live message after seeding lands in the seeded session.
		await logChannelMessage(env.FERMI_DB, 'tg', 'seeded-chat', 'assistant', 'live reply')
		const sessions = await env.FERMI_DB.prepare(
			"SELECT COUNT(DISTINCT session_id) AS n FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.host = 'tg:seeded-chat'",
		).first<{ n: number }>()
		expect(sessions?.n).toBe(1)
	})

	it('re-seeding history replaces only that chat and attributes a sender', async () => {
		await seed(historyFixture)
		await logChannelMessage(env.FERMI_DB, 'sl', 'other-chat', 'user', 'keep me')
		await seed({
			channel: historyFixture.channel,
			chat_id: historyFixture.chat_id,
			sender: 'Owner',
			history: [
				{ role: 'user', text: 'hi', minutes_ago: 2 },
				{ role: 'assistant', text: 'hello', minutes_ago: 1 },
			],
		})
		const out = await dump()
		expect(out.history.map((r: { chat_id: string; text: string }) => [r.chat_id, r.text])).toEqual([
			[historyFixture.chat_id, '[Owner] hi'],
			[historyFixture.chat_id, 'hello'],
			['other-chat', 'keep me'],
		])
	})

	it('rejects malformed history fixtures', () => {
		const ok = { channel: 'sl', chat_id: 'c', history: [] }
		expect(() => seedStatements({ ...ok, channel: 'xx' })).toThrow(/channel/)
		expect(() => seedStatements({ ...ok, chat_id: undefined })).toThrow(/chat_id/)
		expect(() =>
			seedStatements({ ...ok, history: [{ role: 'system', text: 'x', minutes_ago: 1 }] }),
		).toThrow(/role/)
		expect(() =>
			seedStatements({ ...ok, history: [{ role: 'user', text: 'x', minutes_ago: -1 }] }),
		).toThrow(/minutes_ago/)
	})
})
