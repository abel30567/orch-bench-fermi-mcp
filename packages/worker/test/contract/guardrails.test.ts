import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { type GuardrailDef, runWithGuardrails } from '../../src/lib/tool.ts'

const toolT: GuardrailDef = { name: 'guard_test_t', scope: ['shell'], risk: 'high', mutates: true }
const toolU: GuardrailDef = { name: 'guard_test_u', scope: ['shell'], risk: 'high', mutates: true }
const argsA = { target: 'harmless' }
const argsB = { target: 'dangerous' }

function run(def: GuardrailDef, args: Record<string, unknown>, approvalToken?: string) {
	let calls = 0
	const result = runWithGuardrails({
		def,
		args,
		env,
		approvalToken,
		approvalPolicy: 'pending_token',
		handler: async () => {
			calls++
			return 'ran'
		},
	})
	return result.then((r) => ({ result: r, calls }))
}

async function mint(def: GuardrailDef, args: Record<string, unknown>): Promise<string> {
	const { result } = await run(def, args)
	if (result.kind !== 'pending_approval') throw new Error(`expected pending, got ${result.kind}`)
	return result.token
}

async function auditRows() {
	const { results } = await env.FERMI_DB.prepare(
		'SELECT tool, outcome FROM audit ORDER BY id',
	).all<{ tool: string; outcome: string }>()
	return results
}

describe('approval tokens', () => {
	it('denies redeeming with different args and does not run the handler', async () => {
		const token = await mint(toolT, argsA)
		const { result, calls } = await run(toolT, argsB, token)
		expect(result).toEqual({ kind: 'denied', reason: 'invalid_or_expired_token' })
		expect(calls).toBe(0)
	})

	it('denies redeeming for a different tool', async () => {
		const token = await mint(toolT, argsA)
		const { result, calls } = await run(toolU, argsA, token)
		expect(result).toEqual({ kind: 'denied', reason: 'invalid_or_expired_token' })
		expect(calls).toBe(0)
	})

	it('redeems with the minting tool and args exactly once', async () => {
		const token = await mint(toolT, argsA)
		const first = await run(toolT, argsA, token)
		expect(first.result).toEqual({ kind: 'ok', value: 'ran' })
		expect(first.calls).toBe(1)

		const second = await run(toolT, argsA, token)
		expect(second.result).toEqual({ kind: 'denied', reason: 'invalid_or_expired_token' })
		expect(second.calls).toBe(0)
	})

	it('a mismatched redeem does not burn the token for the matching call', async () => {
		const token = await mint(toolT, argsA)
		await run(toolT, argsB, token)
		const { result } = await run(toolT, argsA, token)
		expect(result).toEqual({ kind: 'ok', value: 'ran' })
	})

	it('excludes approval_token from the args hash', async () => {
		const token = await mint(toolT, argsA)
		const { result } = await run(toolT, { ...argsA, approval_token: token }, token)
		expect(result).toEqual({ kind: 'ok', value: 'ran' })
	})
})

describe('plan mode', () => {
	it('writes exactly one denied audit row for a blocked call', async () => {
		let calls = 0
		const result = await runWithGuardrails({
			def: { name: 'guard_test_plan', scope: ['write:fs'], risk: 'low', mutates: true },
			args: { path: '/x' },
			env,
			agentState: { mode: 'plan', sessionId: 's-plan' },
			approvalPolicy: 'none',
			handler: async () => {
				calls++
				return 'ran'
			},
		})
		expect(result).toMatchObject({ kind: 'denied', reason: 'plan_mode_restricted' })
		expect(calls).toBe(0)
		expect(await auditRows()).toEqual([{ tool: 'guard_test_plan', outcome: 'denied' }])
	})
})
