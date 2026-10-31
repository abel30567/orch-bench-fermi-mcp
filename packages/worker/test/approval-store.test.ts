import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
	APPROVAL_TOKEN_TTL_MS,
	mintApprovalToken,
	purgeExpiredApprovalTokens,
	redeemApprovalToken,
} from '../src/lib/approval-store.ts'
import { applyMigrations } from './setup-d1.ts'

const NOW = 1_000_000

describe('approval-store', () => {
	beforeAll(applyMigrations)

	beforeEach(async () => {
		await env.FERMI_DB.prepare('DELETE FROM approval_tokens').run()
	})

	it('redeems until the last millisecond before expiry, not at it', async () => {
		const redeem = (token: string, now: number) =>
			redeemApprovalToken(env.FERMI_DB, token, 'tool', 'hash', now)
		const live = await mintApprovalToken(env.FERMI_DB, 'tool', 'hash', NOW)
		const expired = await mintApprovalToken(env.FERMI_DB, 'tool', 'hash', NOW)

		expect(await redeem(live, NOW + APPROVAL_TOKEN_TTL_MS - 1)).toBe(true)
		expect(await redeem(expired, NOW + APPROVAL_TOKEN_TTL_MS)).toBe(false)
	})

	it('purges expired rows and keeps live ones', async () => {
		await mintApprovalToken(env.FERMI_DB, 'tool', 'hash', NOW)
		const live = await mintApprovalToken(env.FERMI_DB, 'tool', 'hash', NOW + 1)

		const purged = await purgeExpiredApprovalTokens(env.FERMI_DB, NOW + APPROVAL_TOKEN_TTL_MS)

		expect(purged).toBe(1)
		const { results } = await env.FERMI_DB.prepare('SELECT token FROM approval_tokens').all()
		expect(results).toEqual([{ token: live }])
	})
})
