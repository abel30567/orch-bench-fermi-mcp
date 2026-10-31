import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { type GuardrailDef, runWithGuardrails } from '../../src/lib/tool.ts'

const toolT: GuardrailDef = { name: 'guard_tool_t', scope: ['shell'], risk: 'high', mutates: true }
const toolU: GuardrailDef = { name: 'guard_tool_u', scope: ['shell'], risk: 'high', mutates: true }
const argsA = { cmd: 'echo harmless' }
const argsB = { cmd: 'rm -rf /' }

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
	it('denies a token redeemed with different args', async () => {
		const token = await mint(toolT, argsA)
		const { result, calls } = await run(toolT, argsB, token)
		expect(result).toMatchObject({ kind: 'denied', reason: 'invalid_or_expired_token' })
		expect(calls).toBe(0)
	})

	it('denies a token redeemed for a different tool', async () => {
		const token = await mint(toolT, argsA)
		const { result, calls } = await run(toolU, argsA, token)
		expect(result).toMatchObject({ kind: 'denied', reason: 'invalid_or_expired_token' })
		expect(calls).toBe(0)
	})

	it('redeems with the minted tool and args exactly once', async () => {
		const token = await mint(toolT, argsA)

		// Mismatched attempts do not consume the token.
		expect((await run(toolT, argsB, token)).result.kind).toBe('denied')
		expect((await run(toolU, argsA, token)).result.kind).toBe('denied')

		const first = await run(toolT, argsA, token)
		expect(first.result).toEqual({ kind: 'ok', value: 'ran' })
		expect(first.calls).toBe(1)

		const second = await run(toolT, argsA, token)
		expect(second.result).toMatchObject({ kind: 'denied', reason: 'invalid_or_expired_token' })
		expect(second.calls).toBe(0)
	})

	it('excludes approval_token from the args hash', async () => {
		const token = await mint(toolT, argsA)
		const { result } = await run(toolT, { ...argsA, approval_token: token }, token)
		expect(result).toEqual({ kind: 'ok', value: 'ran' })
	})
})

describe('plan mode', () => {
	it('audits a plan-mode denial with exactly one denied row', async () => {
		let calls = 0
		const result = await runWithGuardrails({
			def: { name: 'guard_plan_mut', scope: ['write:memory'], risk: 'low', mutates: true },
			args: { key: 'x' },
			env,
			agentState: { mode: 'plan', sessionId: 'sess-plan' },
			approvalPolicy: 'none',
			handler: async () => {
				calls++
				return 'ran'
			},
		})
		expect(result).toMatchObject({ kind: 'denied', reason: 'plan_mode_restricted' })
		expect(calls).toBe(0)
		expect(await auditRows()).toEqual([{ tool: 'guard_plan_mut', outcome: 'denied' }])
	})
})
