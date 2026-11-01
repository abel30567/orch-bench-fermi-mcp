import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../scripts/eval-db.mjs'
import historyFixture from './fixtures/eval/phone-history.json'
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

	it('round-trips the history fixture with timestamps from minutes_ago', async () => {
		const now = Date.now()
		await seed(historyFixture, now)
		const out = await dump()
		expect(out.history).toEqual(
			historyFixture.history.map((t) => ({
				channel: 'sl',
				chat_id: 'D0EVALOWNER',
				role: t.role,
				text: t.text,
				created_at: Math.round(now - t.minutes_ago * 60_000),
			})),
		)
		expect(out.tasks.map((t: { id: string }) => t.id)).toEqual(['eval-task-redial'])
	})

	it('re-seeding history replaces the message log and the chat session', async () => {
		await seed(historyFixture)
		await seed(historyFixture)
		expect((await dump()).history).toHaveLength(historyFixture.history.length)
		const { results } = await env.FERMI_DB.prepare(
			"SELECT mode, ended_at FROM sessions WHERE host = 'sl:D0EVALOWNER'",
		).all()
		expect(results).toEqual([{ mode: 'chat', ended_at: null }])
	})

	it('sender adds the group-chat attribution to user turns only', async () => {
		await seed({
			channel: 'tg',
			chat_id: '-100200',
			sender: 'Eval Owner',
			history: [
				{ role: 'user', text: 'call the plumber', minutes_ago: 2 },
				{ role: 'assistant', text: 'Calling now.', minutes_ago: 1 },
			],
		})
		expect((await dump()).history.map((t: { text: string }) => t.text)).toEqual([
			'[Eval Owner] call the plumber',
			'Calling now.',
		])
	})

	it('rejects malformed history fixtures', () => {
		const turn = { role: 'user', text: 'hi', minutes_ago: 1 }
		expect(() => seedStatements({ history: [turn] })).toThrow(/channel/)
		expect(() => seedStatements({ channel: 'sl', history: [turn] })).toThrow(/chat_id/)
		expect(() =>
			seedStatements({ channel: 'sl', chat_id: 'C1', history: [{ ...turn, role: 'system' }] }),
		).toThrow(/role/)
		expect(() =>
			seedStatements({ channel: 'sl', chat_id: 'C1', history: [{ ...turn, text: '' }] }),
		).toThrow(/text/)
		expect(() =>
			seedStatements({ channel: 'sl', chat_id: 'C1', history: [{ ...turn, minutes_ago: -1 }] }),
		).toThrow(/minutes_ago/)
	})
})
