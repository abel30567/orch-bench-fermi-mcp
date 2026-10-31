import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { type McpClient, resultJson } from './mcp-client.ts'
import { session } from './tool-call.ts'

// The approval gate over MCP, on a high-risk tool whose effect is harmless.

const DENIED = { status: 'denied', reason: 'Invalid or expired approval token' }
const unique = () => `approval_${crypto.randomUUID().slice(0, 8)}`
const args = (name: string) => ({ name, sql: 'SELECT 1' })

async function mint(client: McpClient, name: string): Promise<string> {
	return resultJson<{ token: string }>(await client.callTool('retriever_set', args(name))).token
}

async function redeem(client: McpClient, name: string, token: string) {
	return resultJson<{ status?: string }>(
		await client.callTool('retriever_set', { ...args(name), approval_token: token }),
	)
}

describe('approval tokens', () => {
	let client: McpClient

	beforeEach(async () => {
		client = await session()
	})

	it('lets exactly one of 20 concurrent redeems through', async () => {
		const name = unique()
		const token = await mint(client, name)

		const results = await Promise.all(Array.from({ length: 20 }, () => redeem(client, name, token)))

		const denied = results.filter((r) => r.status === 'denied')
		expect(denied).toHaveLength(19)
		for (const r of denied) expect(r).toEqual(DENIED)
	})

	it('stores the token in D1, expiring 300 s after minting', async () => {
		const before = Date.now()
		const token = await mint(client, unique())
		const row = await env.FERMI_DB.prepare(
			'SELECT expires_at FROM approval_tokens WHERE token = ?1',
		)
			.bind(token)
			.first<{ expires_at: number }>()
		expect(row?.expires_at).toBeGreaterThanOrEqual(before + 300_000)
		expect(row?.expires_at).toBeLessThanOrEqual(Date.now() + 300_000)
		expect(await env.FERMI_KV.get(`approval:${token}`)).toBeNull()
	})

	it('denies an expired token', async () => {
		const name = unique()
		const token = await mint(client, name)
		await env.FERMI_DB.prepare('UPDATE approval_tokens SET expires_at = ?1 WHERE token = ?2')
			.bind(Date.now() - 1, token)
			.run()
		expect(await redeem(client, name, token)).toEqual(DENIED)
	})

	it('denies other args without consuming the token', async () => {
		const name = unique()
		const token = await mint(client, name)
		expect(await redeem(client, unique(), token)).toEqual(DENIED)
		expect(await redeem(client, name, token)).not.toEqual(DENIED)
	})

	it('denies another tool without consuming the token', async () => {
		const name = unique()
		const token = await mint(client, name)
		expect(
			resultJson(await client.callTool('retriever_delete', { name, approval_token: token })),
		).toEqual(DENIED)
		expect(await redeem(client, name, token)).not.toEqual(DENIED)
	})
})
