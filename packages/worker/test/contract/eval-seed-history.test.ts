import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../../scripts/eval-db.mjs'
import { channelHost, logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/history.json'
import { McpClient, resultJson } from './mcp-client.ts'
import { resetTables } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

const MINUTE_MS = 60_000
const TOLERANCE_MS = 60_000

// eval-seed.mjs runs these statements with `wrangler d1 execute`; here they run
// against the contract worker's D1, then the real tools are called over /mcp.
async function seed(seedFixture: object = fixture): Promise<number> {
	const now = Date.now()
	const statements: string[] = seedStatements(seedFixture, now)
	await env.FERMI_DB.batch(statements.map((s) => env.FERMI_DB.prepare(s)))
	return now
}

async function client(): Promise<McpClient> {
	const c = new McpClient()
	await c.initialize()
	return c
}

function expectSeededTurns(turns: Turn[], seededAt: number): void {
	expect(turns.map(({ role, body }) => ({ role, text: body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = seededAt - fixture.history[i].minutes_ago * MINUTE_MS
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(TOLERANCE_MS)
	}
}

beforeEach(() => resetTables('messages', 'sessions'))

describe('eval seed: conversation history', () => {
	it('fixture has a 5-turn history', () => {
		expect(fixture.history).toHaveLength(5)
	})

	it('context_bootstrap returns the seeded turns in order with roles and timestamps', async () => {
		const seededAt = await seed()
		const res = resultJson<{ history: Turn[] }>(
			await (await client()).callTool('context_bootstrap', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expectSeededTurns(res.history, seededAt)
	})

	it('conversation_history returns the seeded turns in order with roles and timestamps', async () => {
		const seededAt = await seed()
		const res = resultJson<{ messages: Turn[]; total: number }>(
			await (await client()).callTool('conversation_history', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expect(res.total).toBe(5)
		expectSeededTurns(res.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seed()
		const res = resultJson<{ results: { role: string; body: string }[] }>(
			await (await client()).callTool('session_search', { query: '"line was busy"' }),
		)
		expect(res.results.map(({ role, body }) => ({ role, body }))).toEqual([
			{ role: 'assistant', body: fixture.history[2].text },
		])
	})

	it('lands in the session logChannelMessage uses, so live turns append to it', async () => {
		await seed()
		await logChannelMessage(env.FERMI_DB, fixture.channel, fixture.chat_id, 'user', 'any update?')
		const { results } = await env.FERMI_DB.prepare(
			'SELECT host, mode, ended_at FROM sessions',
		).all()
		expect(results).toEqual([
			{ host: channelHost(fixture.channel, fixture.chat_id), mode: 'chat', ended_at: null },
		])
		const res = resultJson<{ messages: Turn[] }>(
			await (await client()).callTool('conversation_history', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expect(res.messages.map((m) => m.body)).toEqual([
			...fixture.history.map((t) => t.text),
			'any update?',
		])
	})

	it('a re-seed replaces the chat history instead of appending', async () => {
		await seed()
		await seed()
		const { results } = await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM messages').all()
		expect(results).toEqual([{ n: 5 }])
	})

	it('round-trips through eval-dump', async () => {
		const seededAt = await seed()
		const rowSets = []
		for (const query of Object.values(DUMP_QUERIES)) {
			rowSets.push((await env.FERMI_DB.prepare(query).all()).results)
		}
		const dump = shapeDump(rowSets)
		expect(
			dump.history.map(({ host, channel, chat_id, role, text }) => ({
				host,
				channel,
				chat_id,
				role,
				text,
			})),
		).toEqual(
			fixture.history.map(({ role, text }) => ({
				host: `${fixture.channel}:${fixture.chat_id}`,
				channel: fixture.channel,
				chat_id: fixture.chat_id,
				role,
				text,
			})),
		)
		for (const [i, turn] of dump.history.entries()) {
			expect(turn.created_at).toBe(seededAt - fixture.history[i].minutes_ago * MINUTE_MS)
		}
	})

	it('rejects a turn with an unknown role', () => {
		expect(() =>
			seedStatements({
				channel: 'sl',
				chat_id: 'C1',
				history: [{ role: 'system', text: 'x', minutes_ago: 1 }],
			}),
		).toThrow(/role/)
	})
})
