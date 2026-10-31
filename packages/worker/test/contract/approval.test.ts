import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { resultJson } from './mcp-client.ts'
import { session } from './tool-call.ts'

// Approval tokens are single use even when redeemed concurrently: redemption
// is one conditional DELETE on the D1 approval_tokens table.

describe('approval token redemption', () => {
	it('lets exactly one of 20 concurrent redeems of one token through', async () => {
		const name = `CONTRACT_RACE_${crypto.randomUUID().slice(0, 8)}`
		const args = { name, value: 'race-value' }
		const minter = await session()
		const pending = resultJson<{ status: string; token: string }>(
			await minter.callTool('secret_set', args),
		)
		expect(pending.status).toBe('pending_approval')

		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				minter.callTool('secret_set', { ...args, approval_token: pending.token }),
			),
		)
		const bodies = results.map((r) => resultJson<{ status: string; reason?: string }>(r))

		expect(bodies.filter((b) => b.status === 'stored')).toHaveLength(1)
		const denied = bodies.filter((b) => b.status !== 'stored')
		expect(denied).toHaveLength(19)
		for (const b of denied) {
			expect(b).toEqual({ status: 'denied', reason: 'Invalid or expired approval token' })
		}
		console.log('A', Date.now())
		const row = await env.FERMI_DB.prepare('SELECT token FROM approval_tokens WHERE token = ?')
			.bind(pending.token)
			.first()
		expect(row).toBeNull()
	})

	it('mints a D1 row that expires 300 s after minting and refuses it once expired', async () => {
		const client = await session()
		const args = { name: `CONTRACT_EXP_${crypto.randomUUID().slice(0, 8)}`, value: 'v' }
		const before = Date.now()
		console.log('S', Date.now())
		const { token } = resultJson<{ token: string }>(await client.callTool('secret_set', args))
		console.log('A', Date.now())
		const row = await env.FERMI_DB.prepare('SELECT expires_at FROM approval_tokens WHERE token = ?')
			.bind(token)
			.first<{ expires_at: number }>()
		expect(row?.expires_at).toBeGreaterThanOrEqual(before + 300_000)
		expect(row?.expires_at).toBeLessThanOrEqual(Date.now() + 300_000)

		console.log('B', Date.now())
		await env.FERMI_DB.prepare('UPDATE approval_tokens SET expires_at = ? WHERE token = ?')
			.bind(Date.now() - 1, token)
			.run()
		console.log('C', Date.now())
		expect(
			resultJson(await client.callTool('secret_set', { ...args, approval_token: token })),
		).toEqual({ status: 'denied', reason: 'Invalid or expired approval token' })
	})
})
