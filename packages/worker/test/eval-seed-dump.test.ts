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

	describe('history', () => {
		const MINUTE = 60_000
		const turns = historyFixture.history

		it('round-trips a 5-turn history with timestamps minutes_ago before seed time', async () => {
			await seed(historyFixture)
			const seededAt = Date.now()
			const { history } = await dump()
			expect(turns).toHaveLength(5)
			expect(
				history.map(({ channel, chat_id, role, text }) => ({ channel, chat_id, role, text })),
			).toEqual(turns.map(({ role, text }) => ({ channel: 'tg', chat_id: '1000001', role, text })))
			for (const [i, turn] of turns.entries()) {
				const expected = seededAt - turn.minutes_ago * MINUTE
				expect(Math.abs(history[i].created_at - expected)).toBeLessThanOrEqual(60_000)
			}
		})

		it('writes the rows logChannelMessage would find: later turns join the seeded session', async () => {
			await seed(historyFixture)
			await logChannelMessage(env.FERMI_DB, 'tg', '1000001', 'user', 'redial now please')
			const sessions = await env.FERMI_DB.prepare(
				"SELECT mode, ended_at FROM sessions WHERE host = 'tg:1000001'",
			).all()
			expect(sessions.results).toEqual([{ mode: 'chat', ended_at: null }])
			const { history } = await dump()
			expect(history.map((m: { text: string }) => m.text)).toEqual([
				...turns.map((t) => t.text),
				'redial now please',
			])
		})

		it('re-seeding replaces only that chat history', async () => {
			await logChannelMessage(env.FERMI_DB, 'sl', 'C0OTHER', 'user', 'other chat')
			await seed(historyFixture)
			await seed(historyFixture)
			const { history } = await dump()
			expect(history.filter((m: { chat_id: string }) => m.chat_id === '1000001')).toHaveLength(5)
			expect(history.filter((m: { chat_id: string }) => m.chat_id === 'C0OTHER')).toHaveLength(1)
		})

		it('stamps created_at from the seed time', async () => {
			const now = 1_800_000_000_000
			await seed(
				{ channel: 'wa', chat_id: 'w1', history: [{ role: 'user', text: 'hi', minutes_ago: 30 }] },
				now,
			)
			const { history } = await dump()
			expect(history.find((m: { chat_id: string }) => m.chat_id === 'w1')).toEqual({
				channel: 'wa',
				chat_id: 'w1',
				role: 'user',
				text: 'hi',
				created_at: now - 30 * MINUTE,
			})
		})

		it('rejects malformed history fixtures', () => {
			const turn = { role: 'user', text: 'hi', minutes_ago: 1 }
			expect(() => seedStatements({ history: [turn], chat_id: 'c' })).toThrow(/channel/)
			expect(() => seedStatements({ history: [turn], channel: 'tg' })).toThrow(/chat_id/)
			expect(() =>
				seedStatements({ history: [{ ...turn, role: 'system' }], channel: 'tg', chat_id: 'c' }),
			).toThrow(/role/)
			expect(() =>
				seedStatements({ history: [{ ...turn, minutes_ago: -1 }], channel: 'tg', chat_id: 'c' }),
			).toThrow(/minutes_ago/)
		})
	})
})
