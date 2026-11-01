import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../scripts/eval-db.mjs'
import { logChannelMessage } from '../src/lib/conversation.ts'
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

	it('round-trips seeded conversation history in order with timestamps from minutes_ago', async () => {
		const now = Date.now()
		await seed(historyFixture, now)
		await seed(historyFixture, now)
		const out = await dump()
		expect(out.history).toEqual(
			historyFixture.history.map((t) => ({
				channel: historyFixture.channel,
				chat_id: historyFixture.chat_id,
				role: t.role,
				text: t.text,
				created_at: now - t.minutes_ago * 60_000,
			})),
		)
		expect(out.tasks.map((t: { id: string }) => t.id)).toEqual(['eval-task-redial'])
	})

	it('writes the same session and message rows as logChannelMessage', async () => {
		await seed(historyFixture)
		const session = await env.FERMI_DB.prepare(
			'SELECT id, host, mode, ended_at FROM sessions',
		).all()
		expect(session.results).toHaveLength(1)
		expect(session.results[0]).toMatchObject({ host: 'tg:1000001', mode: 'chat', ended_at: null })
		// A live inbound turn joins the seeded session instead of opening a new one.
		await logChannelMessage(env.FERMI_DB, 'tg', '1000001', 'user', 'live turn')
		const sessionIds = await env.FERMI_DB.prepare('SELECT DISTINCT session_id FROM messages').all()
		expect(sessionIds.results).toEqual([{ session_id: session.results[0].id }])
		expect((await dump()).history.at(-1)).toMatchObject({ role: 'user', text: 'live turn' })
	})

	it('attributes user turns to sender like the group gateways', async () => {
		await seed({
			channel: 'sl',
			chat_id: 'C0EVAL',
			sender: 'Eval Owner',
			history: [
				{ role: 'user', text: 'hi', minutes_ago: 2 },
				{ role: 'assistant', text: 'hello', minutes_ago: 1 },
			],
		})
		expect((await dump()).history.map((h: { text: string }) => h.text)).toEqual([
			'[Eval Owner] hi',
			'hello',
		])
	})

	it('rejects malformed history fixtures', () => {
		const turn = { role: 'user', text: 'x', minutes_ago: 1 }
		expect(() => seedStatements({ history: [turn] })).toThrow(/channel and chat_id/)
		expect(() =>
			seedStatements({ channel: 'tg', chat_id: '1', history: [{ ...turn, role: 'system' }] }),
		).toThrow(/role/)
		expect(() =>
			seedStatements({ channel: 'tg', chat_id: '1', history: [{ ...turn, minutes_ago: -1 }] }),
		).toThrow(/minutes_ago/)
	})
})
