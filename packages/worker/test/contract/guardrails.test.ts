import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { McpClient, resultJson } from './mcp-client.ts'

// Guardrails as a client sees them: real worker entry, real defineTool wrapper,
// driven over /mcp. retriever_set / retriever_delete are high-risk mutating
// tools whose handlers only touch local D1 (as does oauth_delete_client).

async function connect(): Promise<McpClient> {
	const client = new McpClient()
	await client.initialize()
	return client
}

async function mint(client: McpClient, tool: string, args: Record<string, unknown>) {
	const body = resultJson<{ status: string; token: string }>(await client.callTool(tool, args))
	expect(body.status).toBe('pending_approval')
	expect(body.token).toBeTruthy()
	return body.token
}

async function auditRows() {
	const { results } = await env.FERMI_DB.prepare(
		'SELECT tool, outcome FROM audit ORDER BY id',
	).all<{ tool: string; outcome: string }>()
	return results
}

async function retrieverCount() {
	const row = await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM retrievers').first<{
		n: number
	}>()
	return row?.n ?? 0
}

const ARGS_A = { name: 'r_a', sql: 'SELECT 1' }
const ARGS_B = { name: 'r_b', sql: 'SELECT 2' }

describe('approval tokens', () => {
	it('are bound to their arguments: a token minted for A cannot run B', async () => {
		const client = await connect()
		const token = await mint(client, 'retriever_set', ARGS_A)

		const res = await client.callTool('retriever_set', { ...ARGS_B, approval_token: token })
		expect(resultJson(res)).toEqual({
			status: 'denied',
			reason: 'Invalid or expired approval token',
		})
		expect(await retrieverCount()).toBe(0)
		expect((await auditRows()).at(-1)).toEqual({ tool: 'retriever_set', outcome: 'denied' })
	})

	it('are bound to their tool: a token minted for T cannot run U, even with equal args', async () => {
		// Both tools take exactly { name }, so only the tool binding can tell them apart.
		const client = await connect()
		const token = await mint(client, 'retriever_delete', { name: 'r_a' })

		const res = await client.callTool('oauth_delete_client', { name: 'r_a', approval_token: token })
		expect(resultJson(res)).toEqual({
			status: 'denied',
			reason: 'Invalid or expired approval token',
		})
		expect((await auditRows()).at(-1)).toEqual({ tool: 'oauth_delete_client', outcome: 'denied' })
	})

	it('redeem once with the minted args after mismatched attempts, then deny reuse', async () => {
		const client = await connect()
		const token = await mint(client, 'retriever_set', ARGS_A)

		// Mismatched redeems are denied and do not consume the token.
		await client.callTool('retriever_set', { ...ARGS_B, approval_token: token })
		await client.callTool('retriever_delete', { name: 'r_a', approval_token: token })

		const ok = resultJson(
			await client.callTool('retriever_set', { ...ARGS_A, approval_token: token }),
		)
		expect(ok.status).toBe('stored')
		expect(await retrieverCount()).toBe(1)

		const replay = resultJson(
			await client.callTool('retriever_set', { ...ARGS_A, approval_token: token }),
		)
		expect(replay).toEqual({ status: 'denied', reason: 'Invalid or expired approval token' })
		expect(await env.FERMI_KV.get(`approval:${token}`)).toBeNull()

		const outcomes = (await auditRows()).map((r) => r.outcome)
		expect(outcomes).toEqual(['pending', 'denied', 'denied', 'ok', 'denied'])
	})
})

describe('plan mode', () => {
	it('a blocked mutating call writes exactly one denied audit row', async () => {
		const client = await connect()
		await client.callTool('session_set_mode', { mode: 'plan' })
		const before = await auditRows()

		const res = await client.callTool('retriever_set', ARGS_A)
		expect(resultJson(res).error).toBe('plan_mode_restricted')
		expect(await retrieverCount()).toBe(0)

		const added = (await auditRows()).slice(before.length)
		expect(added).toEqual([{ tool: 'retriever_set', outcome: 'denied' }])
	})
})
