import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../../scripts/eval-db.mjs'
import { getOrCreateChannelSession, logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

// eval-seed.mjs writes these statements with `wrangler d1 execute`; here they run
// against the contract worker's D1, and the tools are called over /mcp.
async function seed(f: object = fixture): Promise<number> {
	const now = Date.now()
	await env.FERMI_DB.batch(seedStatements(f, now).map((s: string) => env.FERMI_DB.prepare(s)))
	return now
}

function expectTurns(turns: Turn[], seededAt: number): void {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, body: text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = seededAt - fixture.history[i].minutes_ago * 60_000
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

beforeEach(() => resetTables('messages', 'sessions', 'allowlist'))

describe('eval seed: conversation history', () => {
	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		const seededAt = await seed()
		const client = await session()
		const args = { channel: fixture.channel, chat_id: fixture.chat_id }

		const boot = resultJson<{ history: Turn[] }>(await client.callTool('context_bootstrap', args))
		expectTurns(boot.history, seededAt)

		const history = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', args),
		)
		expect(history.total).toBe(5)
		expectTurns(history.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seed()
		const client = await session()
		const res = resultJson<{ results: { role: string; body: string }[] }>(
			await client.callTool('session_search', { query: '"nobody picked up"' }),
		)
		expect(res.results.map(({ role, body }) => ({ role, body }))).toEqual([
			{ role: 'assistant', body: fixture.history[2].text },
		])
	})

	it('seeds the open session logChannelMessage appends to', async () => {
		await seed()
		const sessionId = await getOrCreateChannelSession(env.FERMI_DB, 'tg', fixture.chat_id)
		expect(
			await env.FERMI_DB.prepare('SELECT host, mode, ended_at FROM sessions WHERE id = ?')
				.bind(sessionId)
				.first(),
		).toEqual({ host: `tg:${fixture.chat_id}`, mode: 'chat', ended_at: null })
		await logChannelMessage(env.FERMI_DB, 'tg', fixture.chat_id, 'user', 'Did they answer?')
		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel: 'tg', chat_id: fixture.chat_id }),
		)
		expect(res.messages.map((m) => m.body)).toEqual([
			...fixture.history.map((t) => t.text),
			'Did they answer?',
		])
	})

	it('re-seeding replaces only that chat', async () => {
		await logChannelMessage(env.FERMI_DB, 'tg', 'other-chat', 'user', 'keep me')
		await seed()
		await seed()
		const { results } = await env.FERMI_DB.prepare(
			'SELECT s.host, COUNT(*) AS n FROM messages m JOIN sessions s ON m.session_id = s.id GROUP BY s.host ORDER BY s.host',
		).all()
		expect(results).toEqual([
			{ host: 'tg:1000001', n: 5 },
			{ host: 'tg:other-chat', n: 1 },
		])
	})

	it('round-trips through eval-dump', async () => {
		const seededAt = await seed()
		const rowSets = []
		for (const query of Object.values(DUMP_QUERIES)) {
			rowSets.push((await env.FERMI_DB.prepare(query as string).all()).results)
		}
		const dump = shapeDump(rowSets)
		expect(
			dump.history.map(({ channel, chat_id, role, text }: Record<string, unknown>) => ({
				channel,
				chat_id,
				role,
				text,
			})),
		).toEqual(
			fixture.history.map(({ role, text }) => ({
				channel: fixture.channel,
				chat_id: fixture.chat_id,
				role,
				text,
			})),
		)
		const minutesAgo = dump.history.map(
			(t: { created_at: number }) => (seededAt - t.created_at) / 60_000,
		)
		expect(minutesAgo).toEqual(fixture.history.map((t) => t.minutes_ago))
	})

	it('rejects history without a channel chat or with a bad role', () => {
		expect(() => seedStatements({ history: [] })).toThrow(/channel .* and chat_id/)
		expect(() =>
			seedStatements({
				channel: 'tg',
				chat_id: 'x',
				history: [{ role: 'system', text: 'hi', minutes_ago: 1 }],
			}),
		).toThrow(/role must be/)
		expect(() =>
			seedStatements({ channel: 'tg', chat_id: 'x', history: [{ role: 'user', text: 'hi' }] }),
		).toThrow(/minutes_ago/)
	})
})
