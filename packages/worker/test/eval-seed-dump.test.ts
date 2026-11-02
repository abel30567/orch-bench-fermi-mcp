import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../scripts/eval-db.mjs'
import redial from './fixtures/eval/phone-redial.json'
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
			'history',
			'outbox',
			'schedules',
			'skills',
			'audit',
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

	it('round-trips a conversation history fixture', async () => {
		const now = Date.now()
		await seed(redial, now)
		const out = await dump()
		const { channel, chat_id, sender: _sender, history, ...rest } = redial
		expect(out).toMatchObject(rest)
		expect(out.history).toEqual(
			history.map((t) => ({
				channel,
				chat_id,
				role: t.role,
				text: t.text,
				created_at: now - t.minutes_ago * 60_000,
			})),
		)
	})

	it('re-seeding history replaces every channel conversation but keeps MCP sessions', async () => {
		await env.FERMI_DB.prepare(
			"INSERT INTO sessions (id, host, mode, started_at) VALUES ('mcp-keep', 'mcp', 'chat', 1)",
		).run()
		await seed({
			channel: 'sl',
			chat_id: 'C0OLD',
			history: [{ role: 'user', text: 'old', minutes_ago: 1 }],
		})
		await seed(redial)
		await seed(redial)
		const out = await dump()
		expect(out.history.map((t: { text: string }) => t.text)).toEqual(
			redial.history.map((t) => t.text),
		)
		const hosts = await env.FERMI_DB.prepare('SELECT host FROM sessions ORDER BY host').all()
		expect(hosts.results.map((r) => r.host)).toContain('mcp')
		expect(hosts.results.filter((r) => r.host === 'tg:1000001')).toHaveLength(1)
	})

	it('rejects history it cannot place in a chat', () => {
		const turn = { role: 'user', text: 'hi', minutes_ago: 1 }
		expect(() => seedStatements({ chat_id: 'c', history: [turn] })).toThrow(/channel/)
		expect(() => seedStatements({ channel: 'tg', history: [turn] })).toThrow(/chat_id/)
		expect(() =>
			seedStatements({ channel: 'tg', chat_id: 'c', history: [{ ...turn, role: 'system' }] }),
		).toThrow(/role/)
		expect(() =>
			seedStatements({
				channel: 'tg',
				chat_id: 'c',
				history: [turn, { ...turn, minutes_ago: 5 }],
			}),
		).toThrow(/older/)
	})
})
