import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { McpClient, resultJson } from './mcp-client.ts'

// Drives the guardrail pipeline (src/lib/tool.ts) through the real /mcp
// endpoint. retriever_delete (tool T) and oauth_delete_client (tool U) are both
// high-risk, mutating, harmless against empty tables and take the same { name }
// args, so only the stored tool name tells their tokens apart.

async function connect(): Promise<McpClient> {
	const client = new McpClient()
	await client.initialize()
	return client
}

async function mint(client: McpClient, args: Record<string, unknown>): Promise<string> {
	const body = resultJson<{ status: string; token: string }>(
		await client.callTool('retriever_delete', args),
	)
	expect(body.status).toBe('pending_approval')
	return body.token
}

function isDenied(body: Record<string, unknown>): boolean {
	return body.status === 'denied' && body.reason === 'Invalid or expired approval token'
}

async function auditRows(tool: string): Promise<Array<{ outcome: string }>> {
	const { results } = await env.FERMI_DB.prepare(
		'SELECT outcome FROM audit WHERE tool = ? ORDER BY id',
	)
		.bind(tool)
		.all<{ outcome: string }>()
	return results
}

describe('approval tokens', () => {
	it('are denied when redeemed with different args', async () => {
		const client = await connect()
		const token = await mint(client, { name: 'GUARD_A' })

		const body = resultJson(
			await client.callTool('retriever_delete', { name: 'GUARD_B', approval_token: token }),
		)

		expect(isDenied(body)).toBe(true)
		expect(await env.FERMI_KV.get(`approval:${token}`)).not.toBeNull()
	})

	it('are denied when redeemed for a different tool', async () => {
		const client = await connect()
		const token = await mint(client, { name: 'GUARD_A' })

		const body = resultJson(
			await client.callTool('oauth_delete_client', { name: 'GUARD_A', approval_token: token }),
		)

		expect(isDenied(body)).toBe(true)
		expect(await env.FERMI_KV.get(`approval:${token}`)).not.toBeNull()
	})

	it('succeed once for the minted tool and args, then are spent', async () => {
		const client = await connect()
		const token = await mint(client, { name: 'GUARD_A' })

		const first = resultJson(
			await client.callTool('retriever_delete', { name: 'GUARD_A', approval_token: token }),
		)
		expect(first).toMatchObject({ name: 'GUARD_A', deleted: false })
		expect(await env.FERMI_KV.get(`approval:${token}`)).toBeNull()

		const second = resultJson(
			await client.callTool('retriever_delete', { name: 'GUARD_A', approval_token: token }),
		)
		expect(isDenied(second)).toBe(true)
	})

	it('survive rejected redeems and still approve the original call', async () => {
		const client = await connect()
		const token = await mint(client, { name: 'GUARD_A' })

		await client.callTool('retriever_delete', { name: 'GUARD_B', approval_token: token })
		await client.callTool('oauth_delete_client', { name: 'GUARD_A', approval_token: token })
		const body = resultJson(
			await client.callTool('retriever_delete', { name: 'GUARD_A', approval_token: token }),
		)

		expect(body).toMatchObject({ name: 'GUARD_A', deleted: false })
		expect((await auditRows('retriever_delete')).map((r) => r.outcome)).toEqual([
			'pending',
			'denied',
			'ok',
		])
	})
})

describe('plan mode', () => {
	it('audits a blocked mutating call as exactly one denied row', async () => {
		const client = await connect()
		await client.callTool('session_set_mode', { mode: 'plan' })

		const body = resultJson(await client.callTool('retriever_delete', { name: 'GUARD_A' }))

		expect(body.error).toBe('plan_mode_restricted')
		expect(await auditRows('retriever_delete')).toEqual([{ outcome: 'denied' }])
	})
})
