import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { McpClient, resultJson } from './mcp-client.ts'

// Guardrail contract: drives the real worker over /mcp, so the approval gate and
// plan-mode check run exactly as an MCP client sees them.

interface Pending {
	status: 'pending_approval'
	token: string
}

const DENIED = { status: 'denied', reason: 'Invalid or expired approval token' }

async function mint(client: McpClient, tool: string, args: Record<string, unknown>) {
	const pending = resultJson<Pending>(await client.callTool(tool, args))
	expect(pending.status).toBe('pending_approval')
	return pending.token
}

async function storedSql(name: string): Promise<string | null> {
	const row = await env.FERMI_DB.prepare('SELECT sql FROM retrievers WHERE name = ?1')
		.bind(name)
		.first<{ sql: string }>()
	return row?.sql ?? null
}

describe('approval tokens', () => {
	let client: McpClient

	beforeEach(async () => {
		client = new McpClient()
		await client.initialize()
	})

	it('redeems only with the args it was minted for, and only once', async () => {
		const argsA = { name: 'guard_args', sql: 'SELECT 1' }
		const argsB = { name: 'guard_args', sql: 'SELECT 2' }
		const token = await mint(client, 'retriever_set', argsA)

		const withB = await client.callTool('retriever_set', { ...argsB, approval_token: token })
		expect(resultJson(withB)).toEqual(DENIED)
		expect(await storedSql('guard_args')).toBeNull()

		const withA = await client.callTool('retriever_set', { ...argsA, approval_token: token })
		expect(resultJson(withA)).toMatchObject({ status: 'stored', sql: 'SELECT 1' })
		expect(await storedSql('guard_args')).toBe('SELECT 1')

		const replay = await client.callTool('retriever_set', { ...argsA, approval_token: token })
		expect(resultJson(replay)).toEqual(DENIED)
	})

	it('redeems only for the tool it was minted for', async () => {
		// Both tools take exactly { name }, so only the tool binding tells them apart.
		const args = { name: 'guard_tool' }
		const token = await mint(client, 'retriever_delete', args)

		const otherTool = await client.callTool('web_session_invalidate', {
			...args,
			approval_token: token,
		})
		expect(resultJson(otherTool)).toEqual(DENIED)

		const sameTool = await client.callTool('retriever_delete', { ...args, approval_token: token })
		expect(resultJson(sameTool)).toEqual({ name: 'guard_tool', deleted: false })
	})
})

describe('plan mode', () => {
	it('audits a denied mutation exactly once', async () => {
		const client = new McpClient()
		await client.initialize()
		await client.callTool('session_set_mode', { mode: 'plan' })

		const blocked = await client.callTool('retriever_set', { name: 'guard_plan', sql: 'SELECT 1' })
		expect(resultJson(blocked)).toMatchObject({ error: 'plan_mode_restricted' })

		const { results } = await env.FERMI_DB.prepare(
			"SELECT tool, outcome, risk FROM audit WHERE outcome = 'denied'",
		).all()
		expect(results).toEqual([{ tool: 'retriever_set', outcome: 'denied', risk: 'high' }])
		expect(await storedSql('guard_plan')).toBeNull()
	})
})
