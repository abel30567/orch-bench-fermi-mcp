import { describe, expect, it } from 'vitest'
import { McpClient, resultJson } from './mcp-client.ts'

// Approval tokens are single use even under concurrency: redemption is one atomic
// D1 DELETE ... RETURNING, so of many simultaneous redeems exactly one passes.
// secret_delete of a missing name is a high-risk call with no side effects.

async function session() {
	const client = new McpClient()
	await client.initialize()
	return client
}

describe('approval token redemption', () => {
	it('lets exactly one of 20 concurrent redeems of one token through', async () => {
		const args = { name: `CONTRACT_RACE_${crypto.randomUUID().slice(0, 8)}` }
		const minter = await session()
		const pending = resultJson<{ status: string; token: string }>(
			await minter.callTool('secret_delete', args),
		)
		expect(pending.status).toBe('pending_approval')

		// Separate sessions, so the redeems run in separate McpAgent Durable Objects.
		const clients = await Promise.all(Array.from({ length: 20 }, session))
		const results = await Promise.all(
			clients.map(async (client) =>
				resultJson<Record<string, unknown>>(
					await client.callTool('secret_delete', { ...args, approval_token: pending.token }),
				),
			),
		)

		const passed = results.filter((r) => r.status !== 'denied')
		expect(passed).toEqual([{ name: args.name, scope: 'app', deleted: false }])
		const denied = results.filter((r) => r.status === 'denied')
		expect(denied).toHaveLength(19)
		for (const r of denied) expect(r.reason).toBe('Invalid or expired approval token')
	})
})
