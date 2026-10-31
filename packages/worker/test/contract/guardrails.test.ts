import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { McpClient, resultJson } from './mcp-client.ts'

const T = 'retriever_delete'
const U = 'oauth_delete_client' // same `{ name }` schema: only the stored tool tells them apart
const ARGS_A = { name: 'alpha' }
const ARGS_B = { name: 'beta' }
const DENIED = { status: 'denied', reason: 'Invalid or expired approval token' }

async function seedRetrievers(...names: string[]) {
	await env.FERMI_DB.batch(
		names.map((name) =>
			env.FERMI_DB.prepare(
				"INSERT INTO retrievers (name, sql, created_at, updated_at) VALUES (?1, 'SELECT 1', 0, 0)",
			).bind(name),
		),
	)
}

async function retrieverNames() {
	const { results } = await env.FERMI_DB.prepare('SELECT name FROM retrievers ORDER BY name').all<{
		name: string
	}>()
	return results.map((r) => r.name)
}

async function auditRows(tool: string) {
	const { results } = await env.FERMI_DB.prepare(
		'SELECT outcome, risk, session_id FROM audit WHERE tool = ?1 ORDER BY id',
	)
		.bind(tool)
		.all<{ outcome: string; risk: string; session_id: string | null }>()
	return results
}

describe('approval tokens', () => {
	let client: McpClient

	beforeEach(async () => {
		client = new McpClient()
		await client.initialize()
		await seedRetrievers('alpha', 'beta')
	})

	async function mint(tool: string, args: Record<string, unknown>) {
		const pending = resultJson<{ status: string; token: string }>(await client.callTool(tool, args))
		expect(pending.status).toBe('pending_approval')
		return pending.token
	}

	async function redeem(tool: string, args: Record<string, unknown>, token: string) {
		return resultJson(await client.callTool(tool, { ...args, approval_token: token }))
	}

	it('denies a token redeemed with different args and keeps it for the approved call', async () => {
		const token = await mint(T, ARGS_A)

		expect(await redeem(T, ARGS_B, token)).toEqual(DENIED)
		expect(await retrieverNames()).toEqual(['alpha', 'beta'])

		expect(await redeem(T, ARGS_A, token)).toMatchObject({ deleted: true })
		expect(await retrieverNames()).toEqual(['beta'])
	})

	it('denies a token redeemed for a different tool with identical args', async () => {
		const token = await mint(T, ARGS_A)

		expect(await redeem(U, ARGS_A, token)).toEqual(DENIED)
		expect((await auditRows(U)).map((r) => r.outcome)).toEqual(['denied'])

		expect(await redeem(T, ARGS_A, token)).toMatchObject({ deleted: true })
	})

	it('redeems once with the approved args, then denies a second redeem', async () => {
		const token = await mint(T, ARGS_A)

		expect(await redeem(T, ARGS_A, token)).toMatchObject({ deleted: true })
		expect(await env.FERMI_KV.get(`approval:${token}`)).toBeNull()

		await seedRetrievers('alpha')
		expect(await redeem(T, ARGS_A, token)).toEqual(DENIED)
		expect(await retrieverNames()).toEqual(['alpha', 'beta'])
		expect((await auditRows(T)).map((r) => r.outcome)).toEqual(['pending', 'ok', 'denied'])
	})

	it('denies an unknown token', async () => {
		expect(await redeem(T, ARGS_A, crypto.randomUUID())).toEqual(DENIED)
		expect(await retrieverNames()).toEqual(['alpha', 'beta'])
	})
})

describe('plan mode', () => {
	it('writes exactly one denied audit row for a blocked call', async () => {
		const client = new McpClient()
		await client.initialize()
		await client.callTool('session_set_mode', { mode: 'plan' })
		await seedRetrievers('alpha')

		const denied = resultJson(await client.callTool(T, ARGS_A))

		expect(denied).toMatchObject({ error: 'plan_mode_restricted' })
		expect(await retrieverNames()).toEqual(['alpha'])
		expect(await auditRows(T)).toEqual([
			{ outcome: 'denied', risk: 'high', session_id: expect.any(String) },
		])
	})
})
