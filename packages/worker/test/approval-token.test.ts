import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { APPROVAL_TOKEN_TTL_MS, runWithGuardrails } from '../src/lib/tool.ts'
import { applyMigrations } from './setup-d1.ts'

const def = { name: 'secret_put', scope: ['write:secrets'], risk: 'high' as const, mutates: true }

function guarded(approvalToken: string | undefined, onRun: () => void, args = { name: 'K' }) {
	return runWithGuardrails({
		def,
		args,
		env,
		approvalToken,
		approvalPolicy: 'pending_token',
		handler: async () => {
			onRun()
			return 'ran'
		},
	})
}

async function mint(args = { name: 'K' }): Promise<string> {
	const pending = await guarded(undefined, () => {}, args)
	if (pending.kind !== 'pending_approval') throw new Error(`expected pending, got ${pending.kind}`)
	return pending.token
}

describe('approval tokens', () => {
	beforeAll(async () => {
		await applyMigrations()
	})

	it('stores a minted token in D1, expiring 300 s later', async () => {
		const before = Date.now()
		const token = await mint()
		const row = await env.FERMI_DB.prepare(
			'SELECT expires_at FROM approval_tokens WHERE token = ?1',
		)
			.bind(token)
			.first<{ expires_at: number }>()
		expect(APPROVAL_TOKEN_TTL_MS).toBe(300_000)
		expect(row?.expires_at).toBeGreaterThanOrEqual(before + 300_000)
		expect(row?.expires_at).toBeLessThanOrEqual(Date.now() + 300_000)
	})

	it('lets exactly one of 20 concurrent redeems through', async () => {
		const token = await mint()
		let runs = 0
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				guarded(token, () => {
					runs++
				}),
			),
		)
		expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1)
		expect(results.filter((r) => r.kind === 'denied')).toHaveLength(19)
		expect(runs).toBe(1)
	})

	it('denies an expired token', async () => {
		const token = await mint()
		await env.FERMI_DB.prepare('UPDATE approval_tokens SET expires_at = ?1 WHERE token = ?2')
			.bind(Date.now() - 1, token)
			.run()
		const result = await guarded(token, () => {})
		expect(result).toEqual({ kind: 'denied', reason: 'invalid_or_expired_token' })
	})

	it('does not consume a token presented with other args', async () => {
		const token = await mint({ name: 'A' })
		expect((await guarded(token, () => {}, { name: 'B' })).kind).toBe('denied')
		expect((await guarded(token, () => {}, { name: 'A' })).kind).toBe('ok')
	})
})
