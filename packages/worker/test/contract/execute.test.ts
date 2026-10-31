import { env } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { callApproved } from './approval.ts'
import { describeTool } from './describe-tool.ts'
import { McpClient, resultJson } from './mcp-client.ts'

// wrangler.test.jsonc has no LOADER (worker_loaders) binding, so execute takes
// its documented fallback instead of running code.

let client: McpClient

beforeEach(async () => {
	client = new McpClient()
	await client.initialize()
})

describeTool('execute', () => {
	const code = 'return 1 + 1'

	it('requires an approval token', async () => {
		expect(resultJson(await client.callTool('execute', { code }))).toMatchObject({
			status: 'pending_approval',
			risk: 'high',
		})
	})

	it('returns the LOADER error when the binding is absent', async () => {
		expect(env.LOADER).toBeUndefined()
		expect(resultJson(await callApproved(client, 'execute', { code }))).toEqual({
			ok: false,
			error:
				'LOADER binding not configured (worker_loaders closed-beta access required on this account)',
		})
	})

	it('lets exactly one of 20 concurrent redeems of one token through', async () => {
		const pending = resultJson<{ token: string }>(await client.callTool('execute', { code }))
		// Separate sessions run in separate Durable Objects, so the redeems truly race.
		const clients = await Promise.all(
			Array.from({ length: 20 }, async () => {
				const c = new McpClient()
				await c.initialize()
				return c
			}),
		)
		const results = await Promise.all(
			clients.map(async (c) =>
				resultJson(await c.callTool('execute', { code, approval_token: pending.token })),
			),
		)
		const denied = { status: 'denied', reason: 'Invalid or expired approval token' }
		expect(results.filter((r) => r.status !== 'denied')).toHaveLength(1)
		expect(results.filter((r) => r.status === 'denied')).toEqual(Array(19).fill(denied))
	})
})
