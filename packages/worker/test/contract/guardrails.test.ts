import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { runWithGuardrails } from '../../src/lib/tool.ts'
import { McpClient, type ToolResult, resultJson } from './mcp-client.ts'

const DENIED = { status: 'denied', reason: 'Invalid or expired approval token' }

async function auditRows(tool: string, outcome: string) {
	const { results } = await env.FERMI_DB.prepare(
		'SELECT tool, outcome, risk, session_id FROM audit WHERE tool = ? AND outcome = ?',
	)
		.bind(tool, outcome)
		.all()
	return results
}

async function storedSql(name: string) {
	return env.FERMI_DB.prepare('SELECT sql FROM retrievers WHERE name = ?')
		.bind(name)
		.first<string>('sql')
}

describe('approval tokens over MCP', () => {
	const argsA = { name: 'report', sql: 'SELECT 1' }
	const argsB = { name: 'report', sql: 'DELETE FROM audit' }
	let client: McpClient
	let token: string

	beforeEach(async () => {
		client = new McpClient()
		await client.initialize()
		const minted = resultJson<{ status: string; token: string }>(
			await client.callTool('retriever_set', argsA),
		)
		expect(minted.status).toBe('pending_approval')
		token = minted.token
	})

	const redeem = (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
		client.callTool(name, { ...args, approval_token: token })

	it('denies a redeem with different args', async () => {
		expect(resultJson(await redeem('retriever_set', argsB))).toEqual(DENIED)
		expect(await storedSql('report')).toBeNull()
		expect(await auditRows('retriever_set', 'denied')).toHaveLength(1)
	})

	it('denies a redeem for a different tool', async () => {
		expect(resultJson(await redeem('retriever_delete', { name: 'report' }))).toEqual(DENIED)
		expect(await auditRows('retriever_delete', 'denied')).toHaveLength(1)
		expect(await auditRows('retriever_delete', 'ok')).toHaveLength(0)
	})

	it('redeems the minted call once, even after mismatched attempts', async () => {
		await redeem('retriever_set', argsB)
		await redeem('retriever_delete', { name: 'report' })

		expect(resultJson(await redeem('retriever_set', argsA))).toMatchObject({ status: 'stored' })
		expect(await storedSql('report')).toBe('SELECT 1')
		expect(await auditRows('retriever_set', 'ok')).toHaveLength(1)

		expect(resultJson(await redeem('retriever_set', argsA))).toEqual(DENIED)
		expect(await auditRows('retriever_set', 'ok')).toHaveLength(1)
	})
})

describe('approval token binding in runWithGuardrails', () => {
	const def = { name: 'tool_t', scope: ['shell' as const], risk: 'high' as const, mutates: true }
	const args = { target: 'x' }

	const run = (
		name: string,
		callArgs: Record<string, unknown>,
		approvalToken?: string,
		handler: () => Promise<string> = async () => 'ran',
	) =>
		runWithGuardrails({
			def: { ...def, name },
			args: callArgs,
			env,
			approvalToken,
			approvalPolicy: 'pending_token',
			handler,
		})

	async function mint() {
		const minted = await run('tool_t', args)
		if (minted.kind !== 'pending_approval') throw new Error(`not minted: ${minted.kind}`)
		return minted.token
	}

	it('denies another tool even when the args are identical', async () => {
		const token = await mint()
		expect(await run('tool_u', args, token)).toEqual({
			kind: 'denied',
			reason: 'invalid_or_expired_token',
		})
		expect((await run('tool_t', args, token)).kind).toBe('ok')
	})

	it('excludes approval_token from the hashed args', async () => {
		const token = await mint()
		const result = await run('tool_t', { ...args, approval_token: token }, token)
		expect(result.kind).toBe('ok')
	})
})

describe('plan-mode denials', () => {
	it('writes exactly one denied audit row and never reaches the approval gate', async () => {
		const client = new McpClient()
		await client.initialize()
		await client.callTool('session_set_mode', { mode: 'plan' })

		const result = await client.callTool('retriever_set', { name: 'p', sql: 'SELECT 1' })

		expect(resultJson(result)).toMatchObject({ error: 'plan_mode_restricted' })
		expect(await auditRows('retriever_set', 'denied')).toEqual([
			{
				tool: 'retriever_set',
				outcome: 'denied',
				risk: 'high',
				session_id: expect.any(String),
			},
		])
		expect(await auditRows('retriever_set', 'pending')).toHaveLength(0)
	})
})
