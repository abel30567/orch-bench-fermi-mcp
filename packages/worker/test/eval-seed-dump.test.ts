import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../scripts/eval-db.mjs'
import historyFixture from './fixtures/eval/phone-history.json'
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
})

describe('eval seed/dump: conversation history', () => {
	beforeAll(async () => {
		await applyMigrations()
	})

	it('round-trips the seeded history through the dump', async () => {
		const now = Date.now()
		const db = env.FERMI_DB
		await db.batch(seedStatements(historyFixture, now).map((s: string) => db.prepare(s)))
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
		// MCP client sessions (and the migration's seed message) are not chat history.
		const all = await db.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>()
		expect(all?.n).toBeGreaterThan(historyFixture.history.length)
	})

	it('orders turns by time, not fixture order', async () => {
		await seed({
			channel: 'sl',
			chat_id: 'C0ORDER',
			history: [
				{ role: 'assistant', text: 'second', minutes_ago: 1 },
				{ role: 'user', text: 'first', minutes_ago: 2 },
			],
		})
		const turns = (await dump()).history.filter((t: { chat_id: string }) => t.chat_id === 'C0ORDER')
		expect(turns.map((t: { text: string }) => t.text)).toEqual(['first', 'second'])
	})

	it.each([
		[{ chat_id: 'c', history: [] }, 'needs the scenario channel'],
		[{ channel: 'tg', history: [] }, 'needs the scenario chat_id'],
		[{ channel: 'tg', chat_id: 'c', history: {} }, 'must be an array'],
		[{ channel: 'tg', chat_id: 'c', sender: 1, history: [] }, 'sender must be a string'],
		[
			{ channel: 'tg', chat_id: 'c', history: [{ role: 'system', text: 'x', minutes_ago: 1 }] },
			'role must be',
		],
		[{ channel: 'tg', chat_id: 'c', history: [{ role: 'user', minutes_ago: 1 }] }, 'text must be'],
		[
			{ channel: 'tg', chat_id: 'c', history: [{ role: 'user', text: 'x', minutes_ago: -1 }] },
			'minutes_ago must be',
		],
	])('rejects an invalid history fixture %#', (f, message) => {
		expect(() => seedStatements(f)).toThrow(message)
	})
})
