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

	it('redeems one token exactly once under 20 concurrent calls', async () => {
		const pending = resultJson<{ token: string }>(await client.callTool('execute', { code }))
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				client.callTool('execute', { code, approval_token: pending.token }).then(resultJson),
			),
		)
		const denied = { status: 'denied', reason: 'Invalid or expired approval token' }
		expect(results.filter((r) => JSON.stringify(r) === JSON.stringify(denied))).toHaveLength(19)
		expect(results.filter((r) => (r as { ok?: boolean }).ok === false)).toHaveLength(1)
	})

	it('returns the LOADER error when the binding is absent', async () => {
		expect(env.LOADER).toBeUndefined()
		expect(resultJson(await callApproved(client, 'execute', { code }))).toEqual({
			ok: false,
			error:
				'LOADER binding not configured (worker_loaders closed-beta access required on this account)',
		})
	})
})
