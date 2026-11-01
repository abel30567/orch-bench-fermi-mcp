import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, shapeDump } from '../../scripts/eval-db.mjs'
import { seedHistory } from '../../scripts/eval-history.mjs'
import { logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

// eval-seed.mjs runs seedHistory against the eval worker's local D1 (via
// wrangler's platform proxy); here it runs against the contract worker's D1,
// and the turns are read back over /mcp exactly as the daemon reads them.

interface Turn {
	role: string
	body: string
	created_at: number
}

const MINUTE = 60_000

beforeEach(() => resetTables('messages', 'sessions'))

function expectSeededTurns(turns: Turn[], now: number) {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, body: text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = now - fixture.history[i].minutes_ago * MINUTE
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

describe('eval seed: conversation history via logChannelMessage', () => {
	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		const now = Date.now()
		expect(await seedHistory(env.FERMI_DB, fixture, now)).toBe(5)
		const client = await session()

		const ctx = resultJson<{ history: Turn[]; prior_summary: null }>(
			await client.callTool('context_bootstrap', { channel: 'tg', chat_id: fixture.chat_id }),
		)
		expect(ctx.prior_summary).toBeNull()
		expectSeededTurns(ctx.history, now)

		const hist = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', { channel: 'tg', chat_id: fixture.chat_id }),
		)
		expect(hist.total).toBe(5)
		expectSeededTurns(hist.messages, now)
		// One chat session, backdated to the oldest turn, like a live chat.
		const sessions = await env.FERMI_DB.prepare(
			'SELECT started_at, ended_at FROM sessions WHERE host = ?1',
		)
			.bind(`tg:${fixture.chat_id}`)
			.all<{ started_at: number; ended_at: number | null }>()
		expect(sessions.results).toEqual([{ started_at: now - 25 * MINUTE, ended_at: null }])
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seedHistory(env.FERMI_DB, fixture)
		const client = await session()
		const res = resultJson<{ results: Array<{ role: string; body: string }>; total: number }>(
			await client.callTool('session_search', { query: '"wombat clinic"' }),
		)
		expect(res.total).toBe(1)
		expect(res.results[0]).toMatchObject({
			role: 'user',
			body: 'Ok, try the wombat clinic line later.',
		})
	})

	it('a live turn after the seed lands after the history in the same session', async () => {
		await seedHistory(env.FERMI_DB, fixture)
		// What channel_send logs after delivering a reply.
		await logChannelMessage(env.FERMI_DB, 'tg', fixture.chat_id, 'assistant', 'Redialing now.')
		const client = await session()
		const hist = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel: 'tg', chat_id: fixture.chat_id }),
		)
		expect(hist.messages.map((m) => m.body).slice(-2)).toEqual([
			'Ok, try the wombat clinic line later.',
			'Redialing now.',
		])
	})

	it('falls back to the first task chat, orders by minutes_ago and attributes a sender', async () => {
		const now = Date.now()
		await seedHistory(
			env.FERMI_DB,
			{
				tasks: [{ channel: 'sl', chat_id: 'C0EVAL' }],
				sender: 'Eval Owner',
				history: [
					{ role: 'assistant', text: 'second', minutes_ago: 5 },
					{ role: 'user', text: 'first', minutes_ago: 10 },
				],
			},
			now,
		)
		const client = await session()
		const hist = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel: 'sl', chat_id: 'C0EVAL' }),
		)
		expect(hist.messages).toEqual([
			{ role: 'user', body: '[Eval Owner] first', created_at: now - 10 * MINUTE },
			{ role: 'assistant', body: 'second', created_at: now - 5 * MINUTE },
		])
	})

	it('re-seeding replaces the chat history instead of appending', async () => {
		await seedHistory(env.FERMI_DB, fixture)
		await seedHistory(env.FERMI_DB, fixture)
		const n = await env.FERMI_DB.prepare(
			'SELECT COUNT(*) AS n FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.host = ?1',
		)
			.bind(`tg:${fixture.chat_id}`)
			.first<{ n: number }>()
		expect(n?.n).toBe(5)
	})

	it('rejects a malformed history', async () => {
		await expect(seedHistory(env.FERMI_DB, { history: [] })).rejects.toThrow(
			'needs channel and chat_id',
		)
		await expect(
			seedHistory(env.FERMI_DB, {
				...fixture,
				history: [{ role: 'system', text: 'x', minutes_ago: 1 }],
			}),
		).rejects.toThrow('role must be user or assistant')
	})

	it('round-trips through the eval-dump queries', async () => {
		const now = Date.now()
		await seedHistory(env.FERMI_DB, fixture, now)
		// MCP tool-call logs (host "mcp") are not chat history.
		await (await session()).callTool('conversation_history', { channel: 'tg', chat_id: 'x' })
		const rowSets = []
		for (const query of Object.values(DUMP_QUERIES)) {
			rowSets.push((await env.FERMI_DB.prepare(query).all()).results)
		}
		const dump = shapeDump(rowSets)
		expect(dump.history).toEqual(
			fixture.history.map(({ role, text, minutes_ago }) => ({
				channel: 'tg',
				chat_id: fixture.chat_id,
				role,
				text,
				created_at: now - minutes_ago * MINUTE,
			})),
		)
	})
})
