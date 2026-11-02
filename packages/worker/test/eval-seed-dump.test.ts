import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../scripts/eval-db.mjs'
import { logChannelMessage } from '../src/lib/conversation.ts'
import phoneFixture from './fixtures/eval/phone-redial.json'
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

		it('round-trips the 5-turn phone fixture with timestamps from minutes_ago', async () => {
			const now = Date.now()
			await seed(phoneFixture, now)
			const out = await dump()
			expect(out.history).toEqual(
				phoneFixture.history.map((t) => ({
					channel: 'tg',
					chat_id: '1000001',
					role: t.role,
					text: t.text,
					created_at: now - t.minutes_ago * MINUTE,
				})),
			)
			const { history: _h, channel: _c, chat_id: _id, ...rest } = phoneFixture
			expect(out).toMatchObject(rest)
		})

		it('writes the same session and message rows as logChannelMessage', async () => {
			await env.FERMI_DB.batch([
				env.FERMI_DB.prepare('DELETE FROM messages'),
				env.FERMI_DB.prepare('DELETE FROM sessions'),
			])
			await logChannelMessage(env.FERMI_DB, 'sl', 'C-real', 'user', 'hello there')
			await logChannelMessage(env.FERMI_DB, 'sl', 'C-real', 'assistant', 'hi back')
			const rows = async (host: string) => {
				const session = await env.FERMI_DB.prepare(
					'SELECT id, host, mode, ended_at, summary FROM sessions WHERE host = ?1',
				)
					.bind(host)
					.all<{ id: string; host: string }>()
				const messages = await env.FERMI_DB.prepare(
					'SELECT session_id, role, body FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.host = ?1 ORDER BY m.id',
				)
					.bind(host)
					.all<{ session_id: string }>()
				const ids = session.results.map((r) => r.id)
				return {
					sessions: session.results.map(({ id: _id, ...r }) => ({
						...r,
						host: r.host.split(':')[0],
					})),
					messages: messages.results.map(({ session_id, ...m }) => ({
						...m,
						session: ids.indexOf(session_id),
					})),
				}
			}
			const real = await rows('sl:C-real')

			// Seeding clears channel conversations, so compare against a snapshot.
			await seed({
				channel: 'sl',
				chat_id: 'C-seed',
				history: [
					{ role: 'user', text: 'hello there', minutes_ago: 1 },
					{ role: 'assistant', text: 'hi back', minutes_ago: 0 },
				],
			})
			expect(await rows('sl:C-seed')).toEqual(real)
			expect(await rows('sl:C-real')).toEqual({ sessions: [], messages: [] })
		})

		it('re-seeding replaces channel history and leaves MCP client sessions alone', async () => {
			await env.FERMI_DB.prepare(
				"INSERT OR IGNORE INTO sessions (id, host, mode, started_at) VALUES ('mcp-client', 'mcp', 'chat', 1)",
			).run()
			await env.FERMI_DB.prepare(
				"INSERT INTO messages (session_id, role, body, created_at) VALUES ('mcp-client', 'user', 'tool args', 1)",
			).run()
			await seed(phoneFixture)
			await seed(phoneFixture)
			expect((await dump()).history).toHaveLength(phoneFixture.history.length)
			const mcp = await env.FERMI_DB.prepare(
				"SELECT COUNT(*) AS n FROM messages WHERE session_id = 'mcp-client'",
			).first<{ n: number }>()
			expect(mcp?.n).toBe(1)
		})

		it('attributes user turns to sender like a group gateway turn', async () => {
			await seed({
				channel: 'dc',
				chat_id: 'G1',
				sender: 'Alice',
				history: [
					{ role: 'user', text: 'ping', minutes_ago: 2 },
					{ role: 'assistant', text: 'pong', minutes_ago: 1 },
				],
			})
			expect((await dump()).history.map((h: { text: string }) => h.text)).toEqual([
				'[Alice] ping',
				'pong',
			])
		})

		it.each([
			[{ chat_id: 'c', history: [] }, /channel/],
			[{ channel: 'xx', chat_id: 'c', history: [] }, /channel/],
			[{ channel: 'tg', history: [] }, /chat_id/],
			[
				{ channel: 'tg', chat_id: 'c', history: [{ role: 'system', text: 'x', minutes_ago: 1 }] },
				/role/,
			],
			[{ channel: 'tg', chat_id: 'c', history: [{ role: 'user', minutes_ago: 1 }] }, /text/],
			[{ channel: 'tg', chat_id: 'c', history: [{ role: 'user', text: 'x' }] }, /minutes_ago/],
			[
				{
					channel: 'tg',
					chat_id: 'c',
					history: [
						{ role: 'user', text: 'a', minutes_ago: 1 },
						{ role: 'user', text: 'b', minutes_ago: 5 },
					],
				},
				/oldest first/,
			],
		])('rejects an invalid history fixture %#', (f, message) => {
			expect(() => seedStatements(f)).toThrow(message)
		})
	})
})
