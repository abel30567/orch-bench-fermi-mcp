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

	describe('history', () => {
		const MINUTE = 60_000

		it('round-trips a 5-turn history through eval-dump', async () => {
			const now = Date.now()
			await seed(historyFixture, now)
			const { history } = await dump()
			expect(history).toHaveLength(5)
			expect(
				history.map(({ channel, chat_id, role, text }: Record<string, unknown>) => ({
					channel,
					chat_id,
					role,
					text,
				})),
			).toEqual(
				historyFixture.history.map(({ role, text }) => ({
					channel: 'tg',
					chat_id: '1000001',
					role,
					text,
				})),
			)
			for (const [i, row] of history.entries()) {
				expect(row.created_at).toBe(now - historyFixture.history[i].minutes_ago * MINUTE)
			}
			expect(new Set(history.map((r: { session_id: string }) => r.session_id)).size).toBe(1)
		})

		it('writes the rows logChannelMessage writes, so a new inbound turn joins the seeded session', async () => {
			await seed(historyFixture)
			await logChannelMessage(env.FERMI_DB, 'tg', '1000001', 'user', 'Did the redial work?')
			const sessions = await env.FERMI_DB.prepare(
				"SELECT host, mode, ended_at FROM sessions WHERE host = 'tg:1000001'",
			).all()
			expect(sessions.results).toEqual([{ host: 'tg:1000001', mode: 'chat', ended_at: null }])
			const { messages } = await getConversationHistory(env.FERMI_DB, 'tg', '1000001')
			expect(messages.map((m) => m.body)).toEqual([
				...historyFixture.history.map((t) => t.text),
				'Did the redial work?',
			])
		})

		it('re-seeding replaces channel history but keeps MCP host sessions', async () => {
			await env.FERMI_DB.prepare(
				"INSERT INTO sessions (id, host, mode, started_at) VALUES ('mcp-keep', 'mcp', 'chat', 1)",
			).run()
			await logChannelMessage(env.FERMI_DB, 'sl', 'C0OTHER', 'user', 'stale chat')
			await seed(historyFixture)
			await seed(historyFixture)
			const { history } = await dump()
			expect(history.map((r: { text: string }) => r.text)).toEqual(
				historyFixture.history.map((t) => t.text),
			)
			const kept = await env.FERMI_DB.prepare(
				"SELECT id FROM sessions WHERE id = 'mcp-keep'",
			).first()
			expect(kept).toEqual({ id: 'mcp-keep' })
		})

		it('rejects history without a valid channel, chat_id or role', () => {
			const history = [{ role: 'user', text: 'hi', minutes_ago: 1 }]
			expect(() => seedStatements({ chat_id: 'c', history })).toThrow(/channel/)
			expect(() => seedStatements({ channel: 'tg', history })).toThrow(/chat_id/)
			expect(() =>
				seedStatements({
					channel: 'tg',
					chat_id: 'c',
					history: [{ role: 'system', text: 'x', minutes_ago: 1 }],
				}),
			).toThrow(/role/)
			expect(() =>
				seedStatements({ channel: 'tg', chat_id: 'c', history: [{ role: 'user', text: 'x' }] }),
			).toThrow(/minutes_ago/)
		})
	})
})
