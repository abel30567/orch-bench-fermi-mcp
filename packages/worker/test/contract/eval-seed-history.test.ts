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

const MINUTE = 60_000
const channelArgs = { channel: fixture.channel, chat_id: fixture.chat_id }

// eval-seed.mjs sends these statements through `wrangler d1 execute`; here they
// run against the same schema, and the real worker reads them back over /mcp.
async function seed(fixtureJson: object, now = Date.now()): Promise<void> {
	await env.FERMI_DB.batch(seedStatements(fixtureJson, now).map((s) => env.FERMI_DB.prepare(s)))
}

async function dump() {
	const rows = await env.FERMI_DB.batch(
		Object.values(DUMP_QUERIES).map((q) => env.FERMI_DB.prepare(q)),
	)
	return shapeDump(rows.map((r) => r.results))
}

function expectFixtureTurns(turns: Turn[], now: number): void {
	expect(turns.map(({ role, body }) => ({ role, text: body }))).toEqual(
		fixture.history.map(({ role, text }) => ({ role, text })),
	)
	for (const [i, turn] of turns.entries()) {
		const expected = now - fixture.history[i].minutes_ago * MINUTE
		expect(Math.abs(turn.created_at - expected)).toBeLessThanOrEqual(MINUTE)
	}
}

describe('eval seed: conversation history', () => {
	beforeEach(() => resetTables('messages', 'sessions'))

	it('context_bootstrap and conversation_history return the turns in order', async () => {
		expect(fixture.history).toHaveLength(5)
		const now = Date.now()
		await seed(fixture, now)
		const client = await session()

		const ctx = resultJson<{ history: Turn[] }>(
			await client.callTool('context_bootstrap', channelArgs),
		)
		expectFixtureTurns(ctx.history, now)

		const history = resultJson<{ messages: Turn[]; total: number }>(
			await client.callTool('conversation_history', channelArgs),
		)
		expect(history.total).toBe(5)
		expectFixtureTurns(history.messages, now)
	})

	it('session_search finds a phrase from a seeded turn', async () => {
		await seed(fixture)
		const client = await session()
		const res = resultJson<{ results: Turn[]; total: number }>(
			await client.callTool('session_search', { query: '"morning slot"' }),
		)
		expect(res).toMatchObject({
			total: 1,
			results: [{ role: 'user', body: 'Thanks, ask for a morning slot.' }],
		})
	})

	it('round-trips through the eval dump', async () => {
		const now = Date.now()
		await seed(fixture, now)
		expect((await dump()).history).toEqual(
			fixture.history.map(({ role, text, minutes_ago }) => ({
				...channelArgs,
				role,
				text,
				created_at: now - minutes_ago * MINUTE,
			})),
		)
	})

	it('later live turns join the seeded open session', async () => {
		const now = Date.now()
		await seed(fixture, now)
		const row = await env.FERMI_DB.prepare(
			'SELECT id, host, mode, started_at, ended_at FROM sessions',
		).first<{ id: string }>()
		expect(row).toMatchObject({
			host: `tg:${fixture.chat_id}`,
			mode: 'chat',
			started_at: now - 45 * MINUTE,
			ended_at: null,
		})
		expect(await getOrCreateChannelSession(env.FERMI_DB, 'tg', fixture.chat_id)).toBe(row?.id)

		await logChannelMessage(env.FERMI_DB, 'tg', fixture.chat_id, 'user', 'calling again?')
		const client = await session()
		const res = resultJson<{ messages: Turn[] }>(
			await client.callTool('conversation_history', channelArgs),
		)
		expect(res.messages).toHaveLength(6)
		expect(res.messages.at(-1)?.body).toBe('calling again?')
	})

	it('a re-seed replaces channel chats and keeps MCP agent sessions', async () => {
		await seed(fixture)
		await env.FERMI_DB.batch([
			env.FERMI_DB.prepare(
				"INSERT INTO sessions (id, host, started_at) VALUES ('agent', 'mcp', 1)",
			),
			env.FERMI_DB.prepare(
				"INSERT INTO messages (session_id, role, body, created_at) VALUES ('agent', 'user', '{}', 1)",
			),
			env.FERMI_DB.prepare(
				"INSERT INTO plans (id, session_id, steps_json) VALUES ('p-eval', 'agent', '[]')",
			),
		])
		await seed({
			channel: 'sl',
			chat_id: 'C0EVAL',
			history: [{ role: 'user', text: 'second seed', minutes_ago: 1 }],
		})
		await env.FERMI_DB.prepare("DELETE FROM plans WHERE id = 'p-eval'").run()

		const { history } = await dump()
		expect(history).toMatchObject([{ channel: 'sl', chat_id: 'C0EVAL', text: 'second seed' }])
		const { results } = await env.FERMI_DB.prepare('SELECT host FROM sessions ORDER BY host').all()
		expect(results).toEqual([{ host: 'mcp' }, { host: 'sl:C0EVAL' }])
		const client = await session()
		const res = resultJson<{ total: number }>(
			await client.callTool('session_search', { query: 'morning' }),
		)
		expect(res.total).toBe(0)
	})

	it('sender attributes user turns as the group gateways do', async () => {
		await seed({ ...fixture, sender: 'Eval Owner' })
		const { history } = await dump()
		expect(history.slice(0, 2).map((t: { text: string }) => t.text)).toEqual([
			'[Eval Owner] Call the dentist and book a cleaning.',
			'Dialing +15555550100 now.',
		])
	})

	it('leaves channel chats alone when the fixture has no history', async () => {
		await seed(fixture)
		await seed({ allowlist: [] })
		expect((await dump()).history).toHaveLength(5)
	})

	it('an empty history clears channel chats', async () => {
		await seed(fixture)
		await seed({ history: [] })
		expect((await dump()).history).toEqual([])
	})

	it.each([
		['no channel', { chat_id: 'c', history: fixture.history }],
		['unknown channel', { channel: 'xx', chat_id: 'c', history: fixture.history }],
		['no chat_id', { channel: 'tg', history: fixture.history }],
		['bad role', { ...channelArgs, history: [{ role: 'system', text: 'x', minutes_ago: 1 }] }],
		['no text', { ...channelArgs, history: [{ role: 'user', minutes_ago: 1 }] }],
		['no minutes_ago', { ...channelArgs, history: [{ role: 'user', text: 'x' }] }],
		[
			'negative minutes_ago',
			{ ...channelArgs, history: [{ role: 'user', text: 'x', minutes_ago: -1 }] },
		],
	])('rejects a fixture with %s', (_name, bad) => {
		expect(() => seedStatements(bad)).toThrow(/fixture history/)
	})
})
