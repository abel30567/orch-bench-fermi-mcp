import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../../scripts/eval-db.mjs'
import { logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

// eval-seed.mjs runs these statements through `wrangler d1 execute --local`;
// here they run against the contract worker's D1, and the conversation tools
// read them back over /mcp exactly as the eval harness would.
async function seed(f: unknown, now = Date.now()) {
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

const { channel, chat_id } = fixture
const expectedTurns = fixture.history.map((t) => ({ role: t.role, body: t.text }))

function expectTimestamps(turns: Turn[], seededAt: number) {
	expect(turns).toHaveLength(fixture.history.length)
	for (const [i, turn] of turns.entries()) {
		const expected = seededAt - fixture.history[i].minutes_ago * 60_000
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

beforeEach(() => resetTables('messages', 'sessions', 'tasks', 'allowlist'))

describe('eval seed: conversation history', () => {
	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		const seededAt = Date.now()
		await seed(fixture, seededAt)
		const client = await session()

		const ctx = resultJson<{ history: Turn[] }>(
			await client.callTool('context_bootstrap', { channel, chat_id }),
		)
		expect(ctx.history.map(({ role, body }) => ({ role, body }))).toEqual(expectedTurns)
		expectTimestamps(ctx.history, seededAt)

		const hist = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', { channel, chat_id }),
		)
		expect(hist.total).toBe(5)
		expect(hist.messages.map(({ role, body }) => ({ role, body }))).toEqual(expectedTurns)
		expectTimestamps(hist.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seed(fixture)
		const client = await session()
		const res = resultJson<{ results: Turn[]; total: number }>(
			await client.callTool('session_search', { query: '"line was busy"' }),
		)
		expect(res.total).toBe(1)
		expect(res.results[0]).toMatchObject({
			role: 'assistant',
			body: 'The line was busy, so the cleaning is not booked yet.',
		})
	})

	it('writes the same rows as logChannelMessage, so later live turns join the seeded session', async () => {
		await seed(fixture)
		await logChannelMessage(env.FERMI_DB, channel, chat_id, 'assistant', 'Dialing again.')
		const sessions = await env.FERMI_DB.prepare(
			'SELECT host, mode, ended_at, summary FROM sessions WHERE host = ?',
		)
			.bind(`${channel}:${chat_id}`)
			.all()
		expect(sessions.results).toEqual([
			{ host: 'tg:1000001', mode: 'chat', ended_at: null, summary: null },
		])
		const client = await session()
		const hist = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel, chat_id }),
		)
		expect(hist.messages.map((m) => m.body)).toEqual([
			...expectedTurns.map((t) => t.body),
			'Dialing again.',
		])
	})

	it('round-trips through eval-dump and re-seeding replaces the chat history', async () => {
		const seededAt = Date.now()
		await seed(fixture, seededAt)
		await seed(fixture, seededAt)
		await logChannelMessage(env.FERMI_DB, 'sl', 'C0OTHER', 'user', 'other chat')
		const out = await dump()
		const mine = out.history.filter((h: { chat_id: string }) => h.chat_id === chat_id)
		expect(mine).toEqual(
			fixture.history.map((t) => ({
				channel,
				chat_id,
				role: t.role,
				text: t.text,
				created_at: seededAt - t.minutes_ago * 60_000,
			})),
		)
		expect(out.history.map((h: { text: string }) => h.text)).toContain('other chat')
	})

	it('prefixes user turns with the sender attribution when sender is set', async () => {
		await seed({
			channel: 'sl',
			chat_id: 'C0GROUP',
			sender: 'Eval Owner',
			history: [
				{ role: 'user', text: 'hi', minutes_ago: 2 },
				{ role: 'assistant', text: 'hello', minutes_ago: 1 },
			],
		})
		const client = await session()
		const hist = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel: 'sl', chat_id: 'C0GROUP' }),
		)
		expect(hist.messages.map((m) => m.body)).toEqual(['[Eval Owner] hi', 'hello'])
	})

	it('rejects history without a chat or with an unknown role', () => {
		expect(() => seedStatements({ history: [] })).toThrow(/channel and chat_id/)
		expect(() =>
			seedStatements({
				channel: 'tg',
				chat_id: 'x',
				history: [{ role: 'system', text: 'x', minutes_ago: 0 }],
			}),
		).toThrow(/role/)
	})
})
