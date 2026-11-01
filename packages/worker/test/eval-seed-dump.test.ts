import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../scripts/eval-db.mjs'
import { logChannelMessage } from '../src/lib/conversation.ts'
import phoneFixture from './fixtures/eval/phone-history.json'
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

	it('round-trips seeded conversation history through the dump', async () => {
		const now = 1_800_000_000_000
		await seed(phoneFixture, now)
		const history = (await dump()).history.filter((m: { host: string }) => m.host === 'sl:C0EVAL')
		expect(history).toEqual(
			phoneFixture.history.map((t) => ({
				host: 'sl:C0EVAL',
				role: t.role,
				body: t.role === 'user' ? `[Eval Owner] ${t.text}` : t.text,
				created_at: now - t.minutes_ago * 60_000,
			})),
		)
	})

	it('re-seeding history replaces that chat only', async () => {
		await logChannelMessage(env.FERMI_DB, 'sl', 'C0OTHER', 'user', 'other chat')
		await seed(phoneFixture)
		await seed(phoneFixture)
		const history = (await dump()).history
		expect(history.filter((m: { host: string }) => m.host === 'sl:C0EVAL')).toHaveLength(5)
		expect(history.filter((m: { host: string }) => m.host === 'sl:C0OTHER')).toHaveLength(1)
	})

	it('live logging appends to the seeded session, as with a logged chat', async () => {
		await seed(phoneFixture)
		await logChannelMessage(env.FERMI_DB, 'sl', 'C0EVAL', 'user', 'live turn')
		const { results } = await env.FERMI_DB.prepare(
			"SELECT DISTINCT s.id, s.mode, s.ended_at FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.host = 'sl:C0EVAL'",
		).all()
		expect(results).toEqual([{ id: expect.any(String), mode: 'chat', ended_at: null }])
	})

	it('rejects history without the inbound chat or with a bad role', () => {
		const history = [{ role: 'user', text: 'hi', minutes_ago: 1 }]
		expect(() => seedStatements({ history })).toThrow(/channel/)
		expect(() => seedStatements({ channel: 'sl', history })).toThrow(/chat_id/)
		expect(() =>
			seedStatements({
				channel: 'sl',
				chat_id: 'C',
				history: [{ role: 'system', text: 'x', minutes_ago: 1 }],
			}),
		).toThrow(/role/)
	})
})
