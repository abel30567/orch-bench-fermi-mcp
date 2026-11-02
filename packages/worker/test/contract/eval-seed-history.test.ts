import { env, fetchMock } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { DUMP_QUERIES, seedStatements, shapeDump } from '../../scripts/eval-db.mjs'
import fixture from '../fixtures/eval/history-redial.json'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

// eval-seed.mjs runs these statements through `wrangler d1 execute --local`
// against the eval worker's D1; here they run against the contract D1, and the
// real worker entry reads them back over /mcp.
interface Turn {
	role: string
	body: string
	created_at: number
}

beforeEach(() => resetTables('messages', 'sessions'))

async function seed(now: number) {
	await env.FERMI_DB.batch(seedStatements(fixture, now).map((s: string) => env.FERMI_DB.prepare(s)))
}

function expectSeededTurns(turns: Turn[], seededAt: number) {
	expect(turns.map(({ role, body }) => ({ role, body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, body: text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = seededAt - fixture.history[i].minutes_ago * 60_000
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(60_000)
	}
}

describe('eval seed: conversation history through the conversation store', () => {
	it('context_bootstrap and conversation_history return the seeded turns in order', async () => {
		const seededAt = Date.now()
		await seed(seededAt)
		const client = await session()

		const ctx = resultJson<{ history: Turn[] }>(
			await client.callTool('context_bootstrap', { channel: 'tg', chat_id: '1000001' }),
		)
		expectSeededTurns(ctx.history, seededAt)

		const hist = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', { channel: 'tg', chat_id: '1000001' }),
		)
		expect(hist.total).toBe(5)
		expectSeededTurns(hist.messages, seededAt)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seed(Date.now())
		const client = await session()
		const res = resultJson<{ results: { role: string; body: string }[]; total: number }>(
			await client.callTool('session_search', { query: '"ask me before you dial"' }),
		)
		expect(res.total).toBe(1)
		expect(res.results[0]).toMatchObject({
			role: 'user',
			body: 'Yes, but ask me before you dial.',
		})
	})

	it('eval-dump returns the seeded turns plus the reply channel_send logged', async () => {
		await seed(Date.now())
		fetchMock
			.get('https://api.telegram.org')
			.intercept({ path: '/bottg-contract-token/sendMessage', method: 'POST' })
			.reply(200, JSON.stringify({ ok: true }))
		const client = await session()
		expect(
			resultJson(
				await client.callTool('channel_send', {
					channel: 'tg',
					chat_id: '1000001',
					text: 'Should I dial now?',
				}),
			),
		).toEqual({ ok: true, channel: 'tg' })

		const rowSets = []
		for (const query of Object.values(DUMP_QUERIES)) {
			rowSets.push((await env.FERMI_DB.prepare(query).all()).results)
		}
		const { history } = shapeDump(rowSets)
		expect(
			history.map(({ role, text }: { role: string; text: string }) => ({ role, text })),
		).toEqual([
			...fixture.history.map(({ role, text }) => ({ role, text })),
			{ role: 'assistant', text: 'Should I dial now?' },
		])
		expect(new Set(history.map((t: { session_id: string }) => t.session_id)).size).toBe(1)
	})
})
