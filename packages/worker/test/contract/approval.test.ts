import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { McpClient, resultJson } from './mcp-client.ts'

// The approval gate every high-risk tool shares (src/lib/tool.ts). secret_set is
// the probe: it is high risk and its effect is visible through secret_list.

const DENIED = { status: 'denied', reason: 'Invalid or expired approval token' }

async function session() {
	const client = new McpClient()
	await client.initialize()
	return client
}

async function mint(client: McpClient, args: Record<string, unknown>): Promise<string> {
	const pending = resultJson<{ status: string; token: string }>(
		await client.callTool('secret_set', args),
	)
	expect(pending.status).toBe('pending_approval')
	return pending.token
}

// Twenty-one MCP sessions in one file can exceed the default 5 s per test on a loaded
// full-suite run, and a timed-out race leaves calls in flight that stall later tests.
describe('approval tokens', { timeout: 30_000 }, () => {
	it('stores the token in D1 with a 300 s expiry', async () => {
		const before = Date.now()
		const token = await mint(await session(), { name: 'APPROVAL_ROW', value: 'row-value-123' })
		const row = await env.FERMI_DB.prepare(
			'SELECT expires_at FROM approval_tokens WHERE token = ?1',
		)
			.bind(token)
			.first<{ expires_at: number }>()
		expect(row?.expires_at).toBeGreaterThanOrEqual(before + 300_000)
		expect(row?.expires_at).toBeLessThanOrEqual(Date.now() + 300_000)
	})

	it('redeems once and denies a replay', async () => {
		const client = await session()
		const args = { name: 'APPROVAL_ONCE', value: 'once-value-123' }
		const token = await mint(client, args)
		const first = await client.callTool('secret_set', { ...args, approval_token: token })
		expect(resultJson(first)).toMatchObject({ status: 'stored', name: 'APPROVAL_ONCE' })
		const replay = await client.callTool('secret_set', { ...args, approval_token: token })
		expect(resultJson(replay)).toEqual(DENIED)
	})

	it('lets exactly one of 20 concurrent redeems of one token succeed', async () => {
		const args = { name: 'APPROVAL_RACE', value: 'race-value-123' }
		const token = await mint(await session(), args)
		// Separate sessions, so the redeems run in separate MCP Durable Objects.
		const clients = await Promise.all(Array.from({ length: 20 }, () => session()))
		const results = await Promise.all(
			clients.map((c) => c.callTool('secret_set', { ...args, approval_token: token })),
		)
		const bodies = results.map((r) => resultJson<{ status: string }>(r))
		expect(bodies.filter((b) => b.status === 'stored')).toHaveLength(1)
		expect(bodies.filter((b) => b.status !== 'stored')).toEqual(Array(19).fill(DENIED))
		const used = await env.FERMI_DB.prepare(
			'SELECT COUNT(*) AS n FROM approval_tokens WHERE token = ?1',
		)
			.bind(token)
			.first()
		expect(used).toEqual({ n: 0 })
	})

	it('denies an expired token', async () => {
		const client = await session()
		const args = { name: 'APPROVAL_EXPIRED', value: 'expired-value-123' }
		const token = await mint(client, args)
		await env.FERMI_DB.prepare('UPDATE approval_tokens SET expires_at = ?1 WHERE token = ?2')
			.bind(Date.now() - 1, token)
			.run()
		const result = await client.callTool('secret_set', { ...args, approval_token: token })
		expect(resultJson(result)).toEqual(DENIED)
		const list = resultJson<{ secrets: Array<{ name: string }> }>(
			await client.callTool('secret_list', {}),
		)
		expect(list.secrets.map((s) => s.name)).not.toContain('APPROVAL_EXPIRED')
	})

	it('denies a token presented with other args and leaves it redeemable', async () => {
		const client = await session()
		const args = { name: 'APPROVAL_BOUND', value: 'bound-value-123' }
		const token = await mint(client, args)
		const other = await client.callTool('secret_set', {
			...args,
			value: 'other-value-123',
			approval_token: token,
		})
		expect(resultJson(other)).toEqual(DENIED)
		const ok = await client.callTool('secret_set', { ...args, approval_token: token })
		expect(resultJson(ok)).toMatchObject({ status: 'stored', name: 'APPROVAL_BOUND' })
	})
})
