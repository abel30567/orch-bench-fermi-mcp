import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../../scripts/eval-db.mjs'
import { logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

// eval-seed.mjs runs seedStatements through `wrangler d1 execute`; here they run
// against the contract worker's D1, and the real tools read them back over /mcp.

interface Turn {
	role: string
	body: string
	created_at: number
}

interface DumpTurn extends Turn {
	channel: string
	chat_id: string
}

async function seed(fx: Record<string, unknown>, now = Date.now()): Promise<void> {
	await env.FERMI_DB.batch(seedStatements(fx, now).map((s: string) => env.FERMI_DB.prepare(s)))
}

async function dump(): Promise<{ history: DumpTurn[] }> {
	const rowSets = []
	for (const query of Object.values(DUMP_QUERIES)) {
		rowSets.push((await env.FERMI_DB.prepare(query).all()).results)
	}
	return shapeDump(rowSets)
}

function expectSeededTurns(turns: Turn[], seededAt: number): void {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, body: text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = seededAt - fixture.history[i].minutes_ago * 60_000
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

beforeEach(() => resetTables('tasks', 'messages', 'sessions'))

describe('eval seed: conversation history', () => {
	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		const seededAt = Date.now()
		await seed(fixture, seededAt)
		const client = await session()
		const args = { channel: fixture.channel, chat_id: fixture.chat_id }

		const boot = resultJson<{ history: Turn[] }>(await client.callTool('context_bootstrap', args))
		expectSeededTurns(boot.history, seededAt)

		const history = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', args),
		)
		expect(history.total).toBe(5)
		expectSeededTurns(history.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seed(fixture)
		const client = await session()
		const res = resultJson<{ results: Turn[] }>(
			await client.callTool('session_search', { query: '"line was busy"' }),
		)
		expect(res.results.map((r) => r.body)).toEqual([fixture.history[2].text])
	})

	it('logChannelMessage appends to the seeded session, and a re-seed replaces the chat', async () => {
		await seed(fixture)
		await logChannelMessage(env.FERMI_DB, 'tg', fixture.chat_id, 'user', 'live turn')
		const { results } = await env.FERMI_DB.prepare(
			'SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS turns FROM messages',
		).all()
		expect(results).toEqual([{ sessions: 1, turns: 6 }])

		await seed(fixture)
		expect((await dump()).history.map((t) => t.body)).toEqual(fixture.history.map((t) => t.text))
	})

	it('attributes user turns to an optional sender', async () => {
		await seed({ ...fixture, sender: 'Eval Owner' })
		const bodies = (await dump()).history.map((t) => t.body)
		expect(bodies[0]).toBe(`[Eval Owner] ${fixture.history[0].text}`)
		expect(bodies[1]).toBe(fixture.history[1].text)
	})

	it('round-trips through eval-dump', async () => {
		const seededAt = Date.now()
		await seed(fixture, seededAt)
		const first = await dump()
		expect(first.history).toEqual(
			fixture.history.map(({ role, text, minutes_ago }) => ({
				channel: fixture.channel,
				chat_id: fixture.chat_id,
				role,
				body: text,
				created_at: seededAt - minutes_ago * 60_000,
			})),
		)

		// Re-seeding from the dump reproduces it exactly.
		await resetTables('messages', 'sessions')
		await seed(
			{
				channel: first.history[0].channel,
				chat_id: first.history[0].chat_id,
				history: first.history.map(({ role, body, created_at }) => ({
					role,
					text: body,
					minutes_ago: (seededAt - created_at) / 60_000,
				})),
			},
			seededAt,
		)
		expect((await dump()).history).toEqual(first.history)
	})

	it('rejects history without a known channel and chat', () => {
		expect(() => seedStatements({ history: fixture.history })).toThrow(/channel/)
		expect(() =>
			seedStatements({
				channel: 'tg',
				chat_id: '1',
				history: [{ role: 'system', text: 'x', minutes_ago: 1 }],
			}),
		).toThrow(/role/)
	})
})
