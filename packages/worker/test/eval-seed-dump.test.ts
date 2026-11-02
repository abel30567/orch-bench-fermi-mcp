import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../scripts/eval-db.mjs'
import { getConversationHistory, logChannelMessage } from '../src/lib/conversation.ts'
import historyFixture from './fixtures/eval/history-redial.json'
import fixture from './fixtures/eval/sample.json'
import { applyMigrations } from './setup-d1.ts'

// eval-seed.mjs / eval-dump.mjs run these same statements through
// `wrangler d1 execute --local`; here they run against the test D1.
async function seed(f: unknown, now?: number) {
	const db = env.FERMI_DB
	await db.batch(seedStatements(f, now).map((s: string) => db.prepare(s)))
}

interface DumpedTurn {
	channel: string
	chat_id: string
	session_id: string
	role: string
	text: string
	created_at: number
}

const sessionRows = async () =>
	(
		await env.FERMI_DB.prepare(
			'SELECT host, mode, ended_at, summary FROM sessions WHERE host LIKE ? ORDER BY started_at',
		)
			.bind('tg:%')
			.all()
	).results

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

	it('round-trips conversation history with turns timestamped minutes_ago before seed time', async () => {
		const now = Date.now()
		await seed(historyFixture, now)
		const out = await dump()
		expect(out.history).toHaveLength(5)
		expect(out.history.map(({ role, text }: DumpedTurn) => ({ role, text }))).toEqual(
			historyFixture.history.map(({ role, text }) => ({ role, text })),
		)
		for (const [i, turn] of (out.history as DumpedTurn[]).entries()) {
			expect(turn).toMatchObject({ channel: 'tg', chat_id: '1000001' })
			expect(turn.created_at).toBe(now - historyFixture.history[i].minutes_ago * 60_000)
		}
		expect(new Set(out.history.map((t: DumpedTurn) => t.session_id)).size).toBe(1)
		expect(out.allowlist).toEqual(historyFixture.allowlist)
		expect(out.tasks).toMatchObject(historyFixture.tasks)
	})

	it('writes the same rows logChannelMessage does, and later turns join the seeded session', async () => {
		await seed(historyFixture)
		const seededSessions = await sessionRows()
		const seeded = await getConversationHistory(env.FERMI_DB, 'tg', '1000001')

		await env.FERMI_DB.batch([
			env.FERMI_DB.prepare('DELETE FROM messages'),
			env.FERMI_DB.prepare('DELETE FROM sessions'),
		])
		for (const turn of historyFixture.history) {
			await logChannelMessage(env.FERMI_DB, 'tg', '1000001', turn.role as 'user', turn.text)
		}
		const logged = await getConversationHistory(env.FERMI_DB, 'tg', '1000001')
		expect(await sessionRows()).toEqual(seededSessions)
		const strip = (h: typeof seeded) => h.messages.map(({ role, body }) => ({ role, body }))
		expect(strip(seeded)).toEqual(strip(logged))
		expect(seeded.prior_summary).toBe(logged.prior_summary)

		// The eval's own reply (channel_send -> logChannelMessage) lands in the seeded session.
		await seed(historyFixture)
		await logChannelMessage(env.FERMI_DB, 'tg', '1000001', 'assistant', 'Dialing now.')
		const after = (await dump()).history as DumpedTurn[]
		expect(after).toHaveLength(6)
		expect(after[5]).toMatchObject({ role: 'assistant', text: 'Dialing now.' })
		expect(new Set(after.map((t) => t.session_id)).size).toBe(1)
	})

	it('re-seeding history replaces every channel conversation but keeps MCP host sessions', async () => {
		await env.FERMI_DB.prepare(
			"INSERT OR IGNORE INTO sessions (id, host, mode, started_at) VALUES ('mcp-host', 'claude-desktop', 'chat', 1)",
		).run()
		await logChannelMessage(env.FERMI_DB, 'sl', 'C0OTHER', 'user', 'leftover from another scenario')
		await seed(historyFixture)
		await seed(historyFixture)
		const out = await dump()
		expect(out.history).toHaveLength(5)
		expect(out.history.every((t: DumpedTurn) => t.chat_id === '1000001')).toBe(true)
		const mcp = await env.FERMI_DB.prepare("SELECT id FROM sessions WHERE id = 'mcp-host'").first()
		expect(mcp).toEqual({ id: 'mcp-host' })
	})

	it('attributes user turns to sender like a group-chat webhook', async () => {
		await seed({
			channel: 'sl',
			chat_id: 'C0EVAL',
			sender: 'U0EVALOWNER',
			history: [
				{ role: 'user', text: 'hi all', minutes_ago: 2 },
				{ role: 'assistant', text: 'hello', minutes_ago: 1 },
			],
		})
		expect((await dump()).history.map(({ role, text }: DumpedTurn) => ({ role, text }))).toEqual([
			{ role: 'user', text: '[U0EVALOWNER] hi all' },
			{ role: 'assistant', text: 'hello' },
		])
	})

	it('rejects history without a valid channel, chat_id or turn shape', () => {
		const turn = { role: 'user', text: 'x', minutes_ago: 1 }
		expect(() => seedStatements({ chat_id: 'c', history: [turn] })).toThrow(/channel/)
		expect(() => seedStatements({ channel: 'tg', history: [turn] })).toThrow(/chat_id/)
		expect(() =>
			seedStatements({ channel: 'tg', chat_id: 'c', history: [{ ...turn, role: 'system' }] }),
		).toThrow(/role/)
		expect(() =>
			seedStatements({ channel: 'tg', chat_id: 'c', history: [{ ...turn, minutes_ago: -1 }] }),
		).toThrow(/minutes_ago/)
	})
})
