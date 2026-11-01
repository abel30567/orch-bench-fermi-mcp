import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, historyTurns, seedHistory, shapeDump } from '../../scripts/eval-db.mjs'
import fixture from '../fixtures/eval/history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

const MINUTE = 60_000

// eval-seed.mjs runs seedHistory against the eval worker's local D1 (via
// getPlatformProxy); here it runs against the contract worker's D1, and the
// turns are read back through the real tools over /mcp.
describe('eval seed: conversation history', () => {
	beforeEach(() => resetTables('messages', 'sessions'))

	const expectTurns = (turns: Turn[], now: number) => {
		expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
			fixture.history.map(({ role, text }) => ({ role, body: text })),
		)
		for (const [i, turn] of turns.entries()) {
			const expected = now - fixture.history[i].minutes_ago * MINUTE
			expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
		}
	}

	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		const now = Date.now()
		expect(await seedHistory(env.FERMI_DB, fixture)).toBe(5)

		const client = await session()
		const args = { channel: fixture.channel, chat_id: fixture.chat_id }
		const boot = resultJson<{ history: Turn[] }>(await client.callTool('context_bootstrap', args))
		expectTurns(boot.history, now)
		const hist = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', args),
		)
		expect(hist.total).toBe(5)
		expectTurns(hist.messages, now)
	})

	it('writes through the conversation store: one open session on the chat host', async () => {
		await seedHistory(env.FERMI_DB, fixture)
		const { results } = await env.FERMI_DB.prepare('SELECT host, ended_at FROM sessions').all()
		expect(results).toEqual([{ host: `${fixture.channel}:${fixture.chat_id}`, ended_at: null }])
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seedHistory(env.FERMI_DB, fixture)
		const client = await session()
		const res = resultJson<{ results: Array<{ role: string; body: string }> }>(
			await client.callTool('session_search', { query: '"morning slots"' }),
		)
		expect(res.results.map(({ role, body }) => ({ role, body }))).toEqual([
			{ role: 'user', body: 'Yes, morning slots only please.' },
		])
	})

	it('a re-seed replaces the chat history instead of appending', async () => {
		await seedHistory(env.FERMI_DB, fixture)
		await seedHistory(env.FERMI_DB, fixture)
		const row = await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM messages').first()
		expect(row).toEqual({ n: 5 })
	})

	it('round-trips through the eval-dump queries', async () => {
		const now = Date.now()
		await seedHistory(env.FERMI_DB, fixture, now)
		const rowSets = []
		for (const query of Object.values(DUMP_QUERIES)) {
			rowSets.push((await env.FERMI_DB.prepare(query).all()).results)
		}
		const dump = shapeDump(rowSets)
		expect(dump.history).toEqual(
			fixture.history.map(({ role, text, minutes_ago }) => ({
				channel: fixture.channel,
				chat_id: fixture.chat_id,
				role,
				text,
				created_at: now - minutes_ago * MINUTE,
			})),
		)
	})

	it('orders turns by minutes_ago and rejects malformed history', () => {
		const turns = historyTurns({
			channel: 'sl',
			chat_id: 'C0EVAL',
			history: [
				{ role: 'assistant', text: 'second', minutes_ago: 1 },
				{ role: 'user', text: 'first', minutes_ago: 5 },
			],
		})
		expect(turns.map((t) => t.text)).toEqual(['first', 'second'])
		expect(() => historyTurns({ chat_id: 'x', history: [] })).toThrow(/channel/)
		expect(() => historyTurns({ channel: 'tg', history: [] })).toThrow(/chat_id/)
		expect(() =>
			historyTurns({
				channel: 'tg',
				chat_id: 'x',
				history: [{ role: 'system', text: 'x', minutes_ago: 1 }],
			}),
		).toThrow(/role/)
		expect(() =>
			historyTurns({ channel: 'tg', chat_id: 'x', history: [{ role: 'user', text: 'x' }] }),
		).toThrow(/minutes_ago/)
	})
})
