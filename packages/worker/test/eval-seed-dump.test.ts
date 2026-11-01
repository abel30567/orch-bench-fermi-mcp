import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedHistory, seedStatements, shapeDump } from '../scripts/eval-db.mjs'
import { logChannelMessage } from '../src/lib/conversation.ts'
import historyFixture from './fixtures/eval/history.json'
import fixture from './fixtures/eval/sample.json'
import { applyMigrations } from './setup-d1.ts'

// eval-seed.mjs / eval-dump.mjs run these same statements through
// `wrangler d1 execute --local`; here they run against the test D1.
async function seed(f: unknown, now = Date.now()) {
	const db = env.FERMI_DB
	await db.batch(seedStatements(f, now).map((s: string) => db.prepare(s)))
	await seedHistory(db, f, now)
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

	it('round-trips conversation history with timestamps from minutes_ago', async () => {
		const now = Date.now()
		await seed(historyFixture, now)
		const out = await dump()
		expect(out.history).toEqual(
			historyFixture.history.map((t) => ({
				channel: 'sl',
				chat_id: 'C0EVAL',
				role: t.role,
				text: t.text,
				created_at: now - t.minutes_ago * 60_000,
			})),
		)
		expect(out.tasks.map((t: { id: string }) => t.id)).toEqual(['eval-task-redial'])
	})

	it('re-seeding history replaces the transcript instead of appending', async () => {
		await logChannelMessage(env.FERMI_DB, 'tg', 'other-chat', 'user', 'stale turn')
		await seed(historyFixture)
		await seed(historyFixture)
		const out = await dump()
		expect(out.history.map((t: { text: string }) => t.text)).toEqual(
			historyFixture.history.map((t) => t.text),
		)
		const sessions = await env.FERMI_DB.prepare(
			"SELECT COUNT(*) AS n FROM sessions WHERE host = 'sl:C0EVAL'",
		).first<{ n: number }>()
		expect(sessions?.n).toBe(1)
	})

	it('rejects history without a channel chat or with a malformed turn', async () => {
		const turn = { role: 'user', text: 'hi', minutes_ago: 1 }
		expect(() => seedStatements({ chat_id: 'c', history: [turn] })).toThrow(/channel/)
		expect(() => seedStatements({ channel: 'sl', history: [turn] })).toThrow(/chat_id/)
		expect(() =>
			seedStatements({ channel: 'sl', chat_id: 'c', history: [{ ...turn, role: 'system' }] }),
		).toThrow(/history\[0\]/)
		expect(() =>
			seedStatements({ channel: 'sl', chat_id: 'c', history: [{ role: 'user', text: 'hi' }] }),
		).toThrow(/history\[0\]/)
	})

	it('rejects a sender that is not allowlisted on the channel', async () => {
		await expect(seed({ ...historyFixture, allowlist: [], sender: 'U0STRANGER' })).rejects.toThrow(
			/U0STRANGER is not on the sl allowlist/,
		)
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
