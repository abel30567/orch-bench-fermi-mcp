import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedHistory, seedStatements, shapeDump } from '../scripts/eval-db.mjs'
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

	it('round-trips a conversation history fixture', async () => {
		await env.FERMI_DB.batch([
			env.FERMI_DB.prepare('DELETE FROM messages'),
			env.FERMI_DB.prepare('DELETE FROM sessions'),
		])
		const now = 1_800_000_000_000
		await seed(historyFixture)
		await seedHistory(env.FERMI_DB, historyFixture, now)
		const { allowlist, tasks, history } = await dump()
		expect({ allowlist, tasks }).toMatchObject({
			allowlist: historyFixture.allowlist,
			tasks: historyFixture.tasks,
		})
		expect(history).toEqual(
			historyFixture.history.map(({ role, text, minutes_ago }) => ({
				channel: 'tg',
				chat_id: '1000001',
				role,
				text,
				created_at: now - minutes_ago * 60_000,
			})),
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
