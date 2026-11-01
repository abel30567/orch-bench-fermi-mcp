import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../scripts/eval-db.mjs'
import { getConversationHistory, logChannelMessage } from '../src/lib/conversation.ts'
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

	it('round-trips the history fixture through the dump', async () => {
		const now = Date.now()
		await env.FERMI_DB.batch(
			seedStatements(historyFixture, now).map((q: string) => env.FERMI_DB.prepare(q)),
		)
		const out = await dump()
		const seeded = out.history.filter(
			(t: { channel?: string; chat_id?: string }) =>
				t.channel === historyFixture.channel && t.chat_id === historyFixture.chat_id,
		)
		expect(seeded).toEqual(
			historyFixture.history.map(({ role, text, minutes_ago }) => ({
				channel: historyFixture.channel,
				chat_id: historyFixture.chat_id,
				role,
				text,
				created_at: now - minutes_ago * 60_000,
			})),
		)
	})

	it('writes history the same way logChannelMessage does', async () => {
		const db = env.FERMI_DB
		const turns = [
			{ role: 'user' as const, text: 'call the plumber' },
			{ role: 'assistant' as const, text: 'calling now' },
		]
		for (const t of turns) await logChannelMessage(db, 'sl', 'C0REAL', t.role, t.text)
		await db.batch(
			seedStatements({
				channel: 'sl',
				chat_id: 'C0SEED',
				history: turns.map((t) => ({ ...t, minutes_ago: 1 })),
			}).map((q: string) => db.prepare(q)),
		)
		const rows = async (host: string) =>
			(
				await db
					.prepare(
						`SELECT s.mode, s.ended_at, s.summary, m.role, m.body FROM messages m
						 JOIN sessions s ON m.session_id = s.id WHERE s.host = ?1 ORDER BY m.id`,
					)
					.bind(host)
					.all()
			).results
		expect(await rows('sl:C0SEED')).toEqual(await rows('sl:C0REAL'))

		// Live ingress after seeding continues the seeded session.
		await logChannelMessage(db, 'sl', 'C0SEED', 'user', 'any update?')
		const sessions = await db
			.prepare('SELECT COUNT(*) AS n FROM sessions WHERE host = ?1')
			.bind('sl:C0SEED')
			.first<{ n: number }>()
		expect(sessions?.n).toBe(1)
		const history = await getConversationHistory(db, 'sl', 'C0SEED')
		expect(history.messages.map((m) => m.body)).toEqual([
			'call the plumber',
			'calling now',
			'any update?',
		])
	})

	it('prefixes user turns with the sender attribution', async () => {
		await env.FERMI_DB.batch(
			seedStatements({
				channel: 'dc',
				chat_id: 'G0EVAL',
				sender: 'Eval Owner',
				history: [
					{ role: 'user', text: 'hi', minutes_ago: 2 },
					{ role: 'assistant', text: 'hello', minutes_ago: 1 },
				],
			}).map((q: string) => env.FERMI_DB.prepare(q)),
		)
		const history = await getConversationHistory(env.FERMI_DB, 'dc', 'G0EVAL')
		expect(history.messages.map((m) => m.body)).toEqual(['[Eval Owner] hi', 'hello'])
	})

	it('rejects malformed history fixtures', () => {
		const turn = { role: 'user', text: 'hi', minutes_ago: 1 }
		expect(() => seedStatements({ chat_id: 'c', history: [turn] })).toThrow(/channel/)
		expect(() => seedStatements({ channel: 'tg', history: [turn] })).toThrow(/chat_id/)
		expect(() =>
			seedStatements({ channel: 'tg', chat_id: 'c', history: [{ ...turn, role: 'system' }] }),
		).toThrow(/role/)
		expect(() =>
			seedStatements({ channel: 'tg', chat_id: 'c', history: [{ ...turn, minutes_ago: -1 }] }),
		).toThrow(/minutes_ago/)
		expect(() =>
			seedStatements({
				channel: 'tg',
				chat_id: 'c',
				history: [turn, { ...turn, minutes_ago: 5 }],
			}),
		).toThrow(/oldest first/)
	})
})
