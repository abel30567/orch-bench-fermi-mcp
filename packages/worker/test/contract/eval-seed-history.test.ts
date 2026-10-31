import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedHistory, seedStatements, shapeDump } from '../../scripts/eval-db.mjs'
import { logChannelMessage } from '../../src/lib/conversation.ts'
import fixture from '../fixtures/eval/history.json'
import { McpClient, resultJson } from './mcp-client.ts'

// eval-seed.mjs runs seedStatements against local D1, then seedHistory with a
// D1 adapter over `wrangler d1 execute`; here both run against the contract
// worker's D1 and the turns are read back over /mcp.

interface Turn {
	role: string
	body: string
	created_at: number
}

async function seed(f: Record<string, unknown> = fixture) {
	const statements = seedStatements(f) as string[]
	if (statements.length) await env.FERMI_DB.batch(statements.map((s) => env.FERMI_DB.prepare(s)))
	await seedHistory(env.FERMI_DB, f)
}

function expectSeededTurns(turns: Turn[]) {
	const now = Date.now()
	expect(turns.map((t) => [t.role, t.body])).toEqual(fixture.history.map((t) => [t.role, t.text]))
	for (const [i, t] of turns.entries()) {
		const expected = now - fixture.history[i].minutes_ago * 60_000
		expect(Math.abs(t.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

describe('eval seed: conversation history', () => {
	let client: McpClient

	beforeEach(async () => {
		client = new McpClient()
		await client.initialize()
	})

	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		await seed()
		const args = { channel: fixture.channel, chat_id: fixture.chat_id }

		const boot = resultJson<{ history: Turn[] }>(await client.callTool('context_bootstrap', args))
		expectSeededTurns(boot.history)

		const history = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', args),
		)
		expect(history.total).toBe(5)
		expectSeededTurns(history.messages)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seed()
		const found = resultJson<{ results: Array<{ role: string; body: string }> }>(
			await client.callTool('session_search', { query: 'periwinkle' }),
		)
		expect(found.results).toContainEqual(
			expect.objectContaining({ role: 'user', body: 'Thanks, try the periwinkle line again.' }),
		)
	})

	it('a re-seed replaces the chat history instead of appending', async () => {
		await logChannelMessage(env.FERMI_DB, 'sl', fixture.chat_id, 'user', 'stale turn')
		await seed()
		await seed()
		const history = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expectSeededTurns(history.messages)
	})

	it('round-trips through eval-dump', async () => {
		await seed()
		const rowSets = []
		for (const query of Object.values(DUMP_QUERIES)) {
			rowSets.push((await env.FERMI_DB.prepare(query).all()).results)
		}
		const dump = shapeDump(rowSets)
		const now = Date.now()
		const chat = dump.history.filter(
			(t: { channel: string; chat_id: string }) =>
				t.channel === fixture.channel && t.chat_id === fixture.chat_id,
		)
		expect(
			chat.map((t: { role: string; text: string; created_at: number }) => ({
				role: t.role,
				text: t.text,
				minutes_ago: Math.round((now - t.created_at) / 60_000),
			})),
		).toEqual(fixture.history)
	})

	it('rejects a malformed history before touching D1', () => {
		expect(() => seedStatements({ history: [] })).toThrow(/channel/)
		expect(() =>
			seedStatements({
				channel: 'sl',
				chat_id: 'C1',
				history: [{ role: 'system', text: 'x', minutes_ago: 1 }],
			}),
		).toThrow(/role/)
	})
})
