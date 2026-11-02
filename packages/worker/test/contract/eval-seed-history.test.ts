import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedHistory } from '../../scripts/eval-db.mjs'
import fixture from '../fixtures/eval/history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

// eval-seed.mjs runs seedHistory against the eval worker's local D1 (via
// getPlatformProxy); here it runs against the contract worker's D1, and the
// turns are read back over /mcp exactly as the daemon reads them.

interface Turn {
	role: string
	body: string
	created_at: number
}

const chat = { channel: fixture.channel, chat_id: fixture.chat_id }

function expectSeededTurns(turns: Turn[], checkedAt: number) {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, body: text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = checkedAt - fixture.history[i].minutes_ago * 60_000
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

beforeEach(() => resetTables('messages', 'sessions'))

describe('eval seed: conversation history via the conversation store', () => {
	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		await seedHistory(env.FERMI_DB, fixture)
		const client = await session()

		const ctx = resultJson<{ history: Turn[] }>(await client.callTool('context_bootstrap', chat))
		expectSeededTurns(ctx.history, Date.now())

		const history = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', chat),
		)
		expect(history.total).toBe(5)
		expectSeededTurns(history.messages, Date.now())
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seedHistory(env.FERMI_DB, fixture)
		const client = await session()
		const res = resultJson<{ results: Turn[]; total: number }>(
			await client.callTool('session_search', { query: '"line was busy"' }),
		)
		expect(res.results).toMatchObject([
			{
				role: 'assistant',
				body: 'The line was busy and the call dropped before anyone answered.',
			},
		])
	})

	it('re-seeding replaces the chat history and leaves other chats alone', async () => {
		await seedHistory(env.FERMI_DB, { ...chat, chat_id: 'other', history: fixture.history })
		await seedHistory(env.FERMI_DB, fixture)
		await seedHistory(env.FERMI_DB, fixture)
		const client = await session()
		const own = resultJson<{ total: number }>(await client.callTool('conversation_history', chat))
		const other = resultJson<{ total: number }>(
			await client.callTool('conversation_history', { ...chat, chat_id: 'other' }),
		)
		expect([own.total, other.total]).toEqual([5, 5])
	})

	it('sender adds the group-chat attribution to user turns only', async () => {
		await seedHistory(env.FERMI_DB, {
			channel: 'sl',
			chat_id: 'C0EVAL',
			sender: 'Eval Owner',
			history: [
				{ role: 'user', text: 'hi team', minutes_ago: 2 },
				{ role: 'assistant', text: 'hello', minutes_ago: 1 },
			],
		})
		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', { channel: 'sl', chat_id: 'C0EVAL' }),
		)
		expect(res.messages.map((m) => m.body)).toEqual(['[Eval Owner] hi team', 'hello'])
	})

	it('rejects a fixture the conversation tools could not read back as given', async () => {
		const turn = { role: 'user', text: 'hi', minutes_ago: 1 }
		await expect(
			seedHistory(env.FERMI_DB, { ...chat, channel: 'ph', history: [turn] }),
		).rejects.toThrow('channel')
		await expect(seedHistory(env.FERMI_DB, { channel: 'tg', history: [turn] })).rejects.toThrow(
			'chat_id',
		)
		await expect(
			seedHistory(env.FERMI_DB, { ...chat, history: [{ ...turn, role: 'system' }] }),
		).rejects.toThrow('role')
		await expect(
			seedHistory(env.FERMI_DB, { ...chat, history: [turn, { ...turn, minutes_ago: 5 }] }),
		).rejects.toThrow('minutes_ago')
	})
})
