import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { McpClient, type ToolResult, resultJson } from './mcp-client.ts'

// Approval tokens are single use: redemption is one atomic D1 DELETE, so any
// number of concurrent redeems of one token yields exactly one success.
// retriever_set (high risk) is the probe: each success stores one row.

async function session(): Promise<McpClient> {
	const client = new McpClient()
	await client.initialize()
	return client
}

async function mint(client: McpClient, args: Record<string, unknown>): Promise<string> {
	const pending = resultJson<{ status: string; token: string }>(
		await client.callTool('retriever_set', args),
	)
	expect(pending.status).toBe('pending_approval')
	return pending.token
}

const isStored = (r: ToolResult) => resultJson<{ status?: string }>(r).status === 'stored'
const DENIED = { status: 'denied', reason: 'Invalid or expired approval token' }

describe('approval token redemption', () => {
	it('20 concurrent redeems of one valid token yield exactly one success', async () => {
		const args = { name: 'contract_race', sql: 'SELECT 1' }
		// Separate MCP sessions run in separate Durable Objects, so the redeems
		// really race instead of queueing behind one object.
		const clients = await Promise.all(Array.from({ length: 20 }, () => session()))
		const token = await mint(clients[0] as McpClient, args)

		const results = await Promise.all(
			clients.map((c) => c.callTool('retriever_set', { ...args, approval_token: token })),
		)

		const ok = results.filter(isStored)
		expect(ok).toHaveLength(1)
		for (const r of results.filter((r) => !isStored(r))) expect(resultJson(r)).toEqual(DENIED)
		const { results: audit } = await env.FERMI_DB.prepare(
			"SELECT outcome FROM audit WHERE tool = 'retriever_set' AND outcome = 'ok'",
		).all()
		expect(audit).toHaveLength(1)
		expect(
			await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM approval_tokens WHERE token = ?1')
				.bind(token)
				.first(),
		).toEqual({ n: 0 })
	}, 60_000)

	it('stores the token in D1 with expires_at 300 s after minting', async () => {
		const client = await session()
		const before = Date.now()
		const token = await mint(client, { name: 'contract_ttl', sql: 'SELECT 1' })
		const after = Date.now()
		const row = await env.FERMI_DB.prepare(
			'SELECT expires_at FROM approval_tokens WHERE token = ?1',
		)
			.bind(token)
			.first<{ expires_at: number }>()
		expect(row?.expires_at).toBeGreaterThanOrEqual(before + 300_000)
		expect(row?.expires_at).toBeLessThanOrEqual(after + 300_000)
		expect(await env.FERMI_KV.get(`approval:${token}`)).toBeNull()
	})

	it('denies an expired token', async () => {
		const client = await session()
		const args = { name: 'contract_expired', sql: 'SELECT 1' }
		const token = await mint(client, args)
		await env.FERMI_DB.prepare('UPDATE approval_tokens SET expires_at = ?1 WHERE token = ?2')
			.bind(Date.now() - 1, token)
			.run()
		expect(
			resultJson(await client.callTool('retriever_set', { ...args, approval_token: token })),
		).toEqual(DENIED)
	})

	it('a token minted for other args is denied and stays redeemable for its own', async () => {
		const client = await session()
		const args = { name: 'contract_bound', sql: 'SELECT 1' }
		const token = await mint(client, args)
		expect(
			resultJson(
				await client.callTool('retriever_set', { ...args, sql: 'SELECT 2', approval_token: token }),
			),
		).toEqual(DENIED)
		expect(
			isStored(await client.callTool('retriever_set', { ...args, approval_token: token })),
		).toBe(true)
	})
})
