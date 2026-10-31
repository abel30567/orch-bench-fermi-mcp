import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { resultJson } from './mcp-client.ts'
import { session } from './tool-call.ts'

describe('approval token redemption', () => {
	it('gives 20 concurrent redeems of one token exactly one success', async () => {
		const name = `APPROVAL_RACE_${crypto.randomUUID().slice(0, 8).toUpperCase()}`
		const args = { name, value: 'contract-value' }
		const minter = await session()
		const pending = resultJson<{ status: string; token: string }>(
			await minter.callTool('secret_set', args),
		)
		expect(pending.status).toBe('pending_approval')
		const { ts: mintedAt } = (await env.FERMI_DB.prepare(
			"SELECT MAX(ts) AS ts FROM audit WHERE tool = 'secret_set' AND outcome = 'pending'",
		).first<{ ts: number }>()) as { ts: number }

		// One session per redeem: separate Durable Objects, so nothing serializes them.
		const clients = await Promise.all(Array.from({ length: 20 }, session))
		const results = await Promise.all(
			clients.map((c) => c.callTool('secret_set', { ...args, approval_token: pending.token })),
		)

		const bodies = results.map((r) => resultJson<{ status?: string; reason?: string }>(r))
		expect(bodies.filter((b) => b.status === 'stored')).toHaveLength(1)
		expect(bodies.filter((b) => b.status === 'denied')).toEqual(
			Array(19).fill({ status: 'denied', reason: 'Invalid or expired approval token' }),
		)

		// Independent of the responses: the audit log shows the handler ran once.
		const audit = await env.FERMI_DB.prepare(
			"SELECT COUNT(*) AS n FROM audit WHERE tool = 'secret_set' AND outcome = 'ok' AND ts >= ?1",
		)
			.bind(mintedAt)
			.first<{ n: number }>()
		expect(audit?.n).toBe(1)
	})
})
