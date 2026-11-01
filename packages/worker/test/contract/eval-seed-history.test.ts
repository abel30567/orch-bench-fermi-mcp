import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../../scripts/eval-db.mjs'
import { getOrCreateChannelSession, logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/phone-history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

// eval-seed.mjs runs seedStatements through `wrangler d1 execute --local`
// against the eval worker's D1; here they run against the contract worker's D1
// and the real tools read them back over /mcp.
let seededAt = 0
beforeEach(async () => {
	await resetTables('messages', 'sessions', 'memory', 'profile_docs')
	seededAt = Date.now()
	await env.FERMI_DB.batch(seedStatements(fixture).map((s: string) => env.FERMI_DB.prepare(s)))
})

function expectSeededTurns(turns: Turn[]) {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map((t) => ({ role: t.role, body: t.text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = seededAt - fixture.history[i].minutes_ago * 60_000
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

describe('eval seed: conversation history', () => {
	it('context_bootstrap returns the seeded turns in order with roles and timestamps', async () => {
		const client = await session()
		const res = resultJson<{ history: Turn[]; prior_summary: null }>(
			await client.callTool('context_bootstrap', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expect(res.prior_summary).toBeNull()
		expectSeededTurns(res.history)
	})

	it('conversation_history returns the same turns', async () => {
		const client = await session()
		const res = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expect(res.total).toBe(5)
		expectSeededTurns(res.messages)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		const client = await session()
		const res = resultJson<{ results: Turn[]; total: number }>(
			await client.callTool('session_search', { query: '"wombat clinic"' }),
		)
		expect(res).toMatchObject({
			total: 1,
			results: [{ role: 'user', body: 'Ok, thanks. Try the wombat clinic later.' }],
		})
	})

	it('the next live turn lands in the seeded session, after the seeded ones', async () => {
		const [{ id }] = (
			await env.FERMI_DB.prepare('SELECT id FROM sessions WHERE host = ?')
				.bind(`${fixture.channel}:${fixture.chat_id}`)
				.all<{ id: string }>()
		).results
		expect(await getOrCreateChannelSession(env.FERMI_DB, fixture.channel, fixture.chat_id)).toBe(id)
		await logChannelMessage(env.FERMI_DB, fixture.channel, fixture.chat_id, 'user', 'live turn')

		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expect(res.messages.map((m) => m.body)).toEqual([
			...fixture.history.map((t) => t.text),
			'live turn',
		])
	})

	it('eval-dump returns the history the tools read', async () => {
		const rowSets = []
		for (const query of Object.values(DUMP_QUERIES)) {
			rowSets.push((await env.FERMI_DB.prepare(query).all()).results)
		}
		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expect(shapeDump(rowSets).history).toEqual(
			res.messages.map((m) => ({
				channel: fixture.channel,
				chat_id: fixture.chat_id,
				role: m.role,
				text: m.body,
				created_at: m.created_at,
			})),
		)
	})
})
