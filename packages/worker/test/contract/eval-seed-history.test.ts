import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedHistory, seedStatements } from '../../scripts/eval-db.mjs'
import fixture from '../fixtures/eval/history.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

interface Turn {
	role: string
	body: string
	created_at: number
}

// eval-seed.mjs runs these statements through `wrangler d1 execute --local` and
// seedHistory on the eval worker's local D1; here both run on the contract D1,
// then the real worker answers over /mcp.
async function seed(): Promise<number> {
	const now = Date.now()
	const db = env.FERMI_DB
	await db.batch(seedStatements(fixture, now).map((s: string) => db.prepare(s)))
	await seedHistory(db, fixture, now)
	return now
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

describe('eval seed: conversation history via the conversation store', () => {
	beforeEach(() => resetTables('messages', 'sessions', 'allowlist', 'tasks'))

	it('context_bootstrap returns the seeded turns in order with roles and timestamps', async () => {
		const seededAt = await seed()
		const client = await session()
		const ctx = resultJson<{ history: Turn[] }>(
			await client.callTool('context_bootstrap', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expect(ctx.history).toHaveLength(5)
		expectSeededTurns(ctx.history, seededAt)
	})

	it('conversation_history returns the seeded turns in order with roles and timestamps', async () => {
		const seededAt = await seed()
		const client = await session()
		const res = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', {
				channel: fixture.channel,
				chat_id: fixture.chat_id,
			}),
		)
		expect(res.total).toBe(5)
		expectSeededTurns(res.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seed()
		const client = await session()
		const res = resultJson<{ results: Array<{ role: string; body: string }> }>(
			await client.callTool('session_search', { query: '"line was busy"' }),
		)
		// The search call's own arguments are logged to the MCP session too, so
		// look for the seeded turn among the hits.
		expect(res.results).toContainEqual(
			expect.objectContaining({ role: 'assistant', body: fixture.history[2].text }),
		)
	})
})
