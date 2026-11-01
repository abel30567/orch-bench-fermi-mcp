import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashArgs } from '../../src/lib/audit.ts'
import { McpClient, resultJson } from './mcp-client.ts'

// Guardrail contract over real MCP: approval tokens are bound to the tool and
// args they were minted for and are single use; plan-mode denials are audited.

interface AuditRow {
	tool: string
	args_hash: string
	outcome: string
	risk: string
}

async function auditRows(tool?: string): Promise<AuditRow[]> {
	const stmt = tool
		? env.FERMI_DB.prepare(
				'SELECT tool, args_hash, outcome, risk FROM audit WHERE tool = ?1 ORDER BY id',
			).bind(tool)
		: env.FERMI_DB.prepare('SELECT tool, args_hash, outcome, risk FROM audit ORDER BY id')
	const { results } = await stmt.all<AuditRow>()
	return results
}

async function retrieverCount(): Promise<number> {
	const row = await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM retrievers').first<{
		n: number
	}>()
	return row?.n ?? 0
}

const ARGS_A = { name: 'contract_a', sql: 'SELECT 1' }
const ARGS_B = { name: 'contract_b', sql: 'SELECT 2' }

async function mint(client: McpClient, tool: string, args: Record<string, unknown>) {
	const pending = resultJson<{ status: string; token: string }>(await client.callTool(tool, args))
	expect(pending.status).toBe('pending_approval')
	expect(pending.token).toBeTruthy()
	return pending.token
}

describe('approval tokens', () => {
	let client: McpClient

	beforeEach(async () => {
		client = new McpClient()
		await client.initialize()
	})

	it('stores the tool and the args hash (approval_token excluded) at mint time', async () => {
		const token = await mint(client, 'retriever_set', ARGS_A)
		const stored = await env.FERMI_KV.get<{ tool: string; args_hash: string }>(
			`approval:${token}`,
			'json',
		)
		expect(stored).toEqual({ tool: 'retriever_set', args_hash: await hashArgs(ARGS_A) })
	})

	it('denies redeeming a token with different args, and does not run the handler', async () => {
		const token = await mint(client, 'retriever_set', ARGS_A)
		const denied = resultJson(
			await client.callTool('retriever_set', { ...ARGS_B, approval_token: token }),
		)
		expect(denied).toEqual({ status: 'denied', reason: 'Invalid or expired approval token' })
		expect(await retrieverCount()).toBe(0)
		const rows = await auditRows('retriever_set')
		expect(rows.at(-1)).toMatchObject({ outcome: 'denied', args_hash: await hashArgs(ARGS_B) })
	})

	it('denies redeeming a token for a different tool with identical args', async () => {
		// retriever_delete and oauth_delete_client are both high-risk with args { name }.
		const args = { name: 'contract_a' }
		const token = await mint(client, 'retriever_delete', args)
		const denied = resultJson(
			await client.callTool('oauth_delete_client', { ...args, approval_token: token }),
		)
		expect(denied).toEqual({ status: 'denied', reason: 'Invalid or expired approval token' })
		expect(await auditRows('oauth_delete_client')).toMatchObject([{ outcome: 'denied' }])
		// The token still works for the call it was minted for.
		const ok = resultJson<{ deleted: boolean }>(
			await client.callTool('retriever_delete', { ...args, approval_token: token }),
		)
		expect(ok).toEqual({ name: 'contract_a', deleted: false })
	})

	it('redeems with the minted args exactly once', async () => {
		const token = await mint(client, 'retriever_set', ARGS_A)

		// A mismatched attempt must not burn the token for the legitimate call.
		await client.callTool('retriever_set', { ...ARGS_B, approval_token: token })

		const ok = resultJson<{ status: string }>(
			await client.callTool('retriever_set', { ...ARGS_A, approval_token: token }),
		)
		expect(ok.status).toBe('stored')
		expect(await retrieverCount()).toBe(1)
		expect(await env.FERMI_KV.get(`approval:${token}`)).toBeNull()

		const again = resultJson(
			await client.callTool('retriever_set', { ...ARGS_A, approval_token: token }),
		)
		expect(again).toEqual({ status: 'denied', reason: 'Invalid or expired approval token' })

		const outcomes = (await auditRows('retriever_set')).map((r) => r.outcome)
		expect(outcomes).toEqual(['pending', 'denied', 'ok', 'denied'])
	})

	it('rejects a made-up token', async () => {
		const denied = resultJson(
			await client.callTool('retriever_set', { ...ARGS_A, approval_token: 'not-a-token' }),
		)
		expect(denied).toEqual({ status: 'denied', reason: 'Invalid or expired approval token' })
		expect(await retrieverCount()).toBe(0)
	})
})

describe('plan mode', () => {
	it('writes exactly one denied audit row for a blocked mutating call', async () => {
		const client = new McpClient()
		await client.initialize()
		await client.callTool('session_set_mode', { mode: 'plan' })
		const before = await auditRows()

		const denied = resultJson<{ error: string }>(await client.callTool('retriever_set', ARGS_A))
		expect(denied.error).toBe('plan_mode_restricted')
		expect(await retrieverCount()).toBe(0)

		const after = await auditRows()
		const added = after.slice(before.length)
		expect(added).toEqual([
			{
				tool: 'retriever_set',
				args_hash: await hashArgs(ARGS_A),
				outcome: 'denied',
				risk: 'high',
			},
		])
	})
})
