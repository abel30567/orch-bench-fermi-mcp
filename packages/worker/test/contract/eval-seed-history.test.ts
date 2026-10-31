import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedHistory, shapeDump } from '../../scripts/eval-db.mjs'
import fixture from '../fixtures/eval/history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

beforeEach(() => resetTables('messages', 'sessions'))

// eval-seed.mjs runs seedHistory on the eval worker's local D1 (getPlatformProxy);
// here it runs on the contract worker's D1, then the real tools read it over /mcp.
describe('eval seed: conversation history via logChannelMessage', () => {
	const chat = { channel: fixture.channel, chat_id: fixture.chat_id }

	function expectFixtureTurns(turns: Turn[], seededAt: number) {
		expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
			fixture.history.map(({ role, text }) => ({ role, body: text })),
		)
		for (const [i, turn] of turns.entries()) {
			const expected = seededAt - fixture.history[i].minutes_ago * 60_000
			expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
		}
	}

	it('context_bootstrap and conversation_history return the 5 turns in order', async () => {
		expect(fixture.history).toHaveLength(5)
		const seededAt = Date.now()
		expect(await seedHistory(env.FERMI_DB, fixture)).toBe(5)

		const client = await session()
		const ctx = resultJson<{ history: Turn[] }>(await client.callTool('context_bootstrap', chat))
		expectFixtureTurns(ctx.history, seededAt)
		const res = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', chat),
		)
		expect(res.total).toBe(5)
		expectFixtureTurns(res.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seedHistory(env.FERMI_DB, fixture)
		const client = await session()
		const res = resultJson<{ results: Array<{ role: string; body: string }> }>(
			await client.callTool('session_search', { query: '"call dropped"' }),
		)
		expect(res.results).toMatchObject([{ role: 'assistant', body: fixture.history[2].text }])
	})

	it('round-trips through the eval-dump queries', async () => {
		const seededAt = Date.now()
		await seedHistory(env.FERMI_DB, fixture, seededAt)
		const client = await session()
		await client.callTool('conversation_history', chat) // an MCP session's own log is not history
		const rowSets = []
		for (const query of Object.values(DUMP_QUERIES)) {
			rowSets.push((await env.FERMI_DB.prepare(query).all()).results)
		}
		const { history } = shapeDump(rowSets)
		expect(history).toEqual(
			fixture.history.map(({ role, text, minutes_ago }) => ({
				...chat,
				role,
				text,
				created_at: seededAt - minutes_ago * 60_000,
			})),
		)
	})

	it('a re-seed replaces the chat history, sorted oldest first', async () => {
		await seedHistory(env.FERMI_DB, fixture)
		const now = Date.now()
		await seedHistory(
			env.FERMI_DB,
			{
				...chat,
				history: [
					{ role: 'assistant', text: 'newer', minutes_ago: 1 },
					{ role: 'user', text: 'older', minutes_ago: 5 },
				],
			},
			now,
		)
		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', chat),
		)
		expect(res.messages).toEqual([
			{ role: 'user', body: 'older', created_at: now - 5 * 60_000 },
			{ role: 'assistant', body: 'newer', created_at: now - 60_000 },
		])
	})

	it('rejects history without the inbound chat or with a bad turn', async () => {
		const history = [{ role: 'user', text: 'hi', minutes_ago: 1 }]
		await expect(seedHistory(env.FERMI_DB, { history })).rejects.toThrow('channel and chat_id')
		await expect(
			seedHistory(env.FERMI_DB, {
				...chat,
				history: [{ role: 'system', text: 'x', minutes_ago: 1 }],
			}),
		).rejects.toThrow('role')
		await expect(
			seedHistory(env.FERMI_DB, { ...chat, history: [{ role: 'user', text: 'x' }] }),
		).rejects.toThrow('minutes_ago')
	})
})
