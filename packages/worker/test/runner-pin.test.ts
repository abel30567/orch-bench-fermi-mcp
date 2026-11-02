import { env } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const PIN = { ref: 'a'.repeat(40), files: { 'box-runner.mjs': 'b'.repeat(64) } }
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)

function userData(overrides: Partial<Parameters<typeof bootstrapUserData>[0]> = {}) {
	return bootstrapUserData({
		boxId: 'box-test',
		agentId: 'ca_test',
		queue: 'default',
		route: 'claude',
		ttlSeconds: 3600,
		mcpBaseUrl: 'https://fermi.example.com',
		boxToken: 'box-test.supersecret',
		claudeModel: null,
		runnerPin: PIN,
		...overrides,
	})
}

describe('runner boot pin (#34)', () => {
	beforeAll(setupFleetSchema)

	it('fetch script pins the ref and verifies sha256 with no fallback', () => {
		const script = runnerFetchScript(PIN)
		expect(script).toContain(runnerUrl(PIN.ref))
		expect(script).toContain(SHA_B)
		expect(script).not.toContain('/main/') // no floating branch
		expect(script).not.toContain('|| true') // fail closed, no baked-copy fallback
	})

	it('user-data verifies the runner BEFORE materializing the box token', () => {
		const script = userData()
		const verifyAt = script.indexOf(SHA_B)
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		expect(verifyAt).toBeGreaterThan(-1)
		expect(tokenAt).toBeGreaterThan(-1)
		expect(verifyAt).toBeLessThan(tokenAt)
	})

	it('user-data has no unpinned curl of main', () => {
		expect(userData()).not.toContain('fermi-daemon/main/')
	})

	it('dispatchProvision refuses launch when the runner pin is unset', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'test-env', runner_ref: null, runner_sha256: null }),
		)
		const agent: CloudAgentRow = {
			id: 'ca_pinless',
			status: 'launching',
			route: 'claude',
			queue: 'default',
			prompt: 'x',
			proof_contract: 'y',
			box_id: null,
			ttl_seconds: 3600,
			budget_usd: null,
			cost_usd: 0,
			created_at: Date.now(),
			started_at: null,
			ended_at: null,
			exit_reason: null,
			meta: '{}',
		} as unknown as CloudAgentRow
		const out = await dispatchProvision(env, agent)
		expect(out.dispatched).toBe(false)
		expect(out.reason).toBe('runner_pin_unset')
	})

	it('dispatchProvision passes the pin gate with a legacy single-file pin', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: null, runner_ref: 'a'.repeat(40), runner_sha256: SHA_B }),
		)
		const out = await dispatchProvision(env, { id: 'ca_legacy', box_id: null } as CloudAgentRow)
		expect(out.reason).toBe('no_environment_configured')
	})

	it('dispatchProvision refuses an invalid manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: null,
				runner_ref: 'a'.repeat(40),
				runner_files: { 'lib/x.mjs': SHA_C },
			}),
		)
		const out = await dispatchProvision(env, { id: 'ca_bad', box_id: null } as CloudAgentRow)
		expect(out.reason).toBe('runner_pin_unset')
	})
})

describe('runner pin manifest', () => {
	const ref = 'a'.repeat(40)

	it('legacy single-file config becomes a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: ref, runner_sha256: SHA_B })).toEqual({
			ref,
			files: { 'box-runner.mjs': SHA_B },
		})
	})

	it('reads a multi-file manifest', () => {
		const files = { 'box-runner.mjs': SHA_B, 'harness/claude.mjs': SHA_C, 'lib/report.mjs': SHA_C }
		expect(
			runnerPinFromConfig({ runner_ref: ref, runner_sha256: SHA_B, runner_files: files }),
		).toEqual({ ref, files })
		expect(runnerPinFromConfig({ runner_ref: ref, runner_files: files })).toEqual({ ref, files })
	})

	it('returns null when unset or invalid', () => {
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: ref, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: ref, runner_sha256: 'nothex' })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: "x'; rm -rf /", runner_sha256: SHA_B })).toBeNull()
		// manifest must contain box-runner.mjs
		expect(
			runnerPinFromConfig({ runner_ref: ref, runner_files: { 'lib/x.mjs': SHA_C } }),
		).toBeNull()
		for (const bad of [
			'../x.mjs',
			'/etc/passwd',
			'lib//x.mjs',
			'lib/./x.mjs',
			"a'b.mjs",
			'a b.mjs',
		]) {
			expect(
				runnerPinFromConfig({
					runner_ref: ref,
					runner_files: { 'box-runner.mjs': SHA_B, [bad]: SHA_C },
				}),
			).toBeNull()
		}
		// legacy hash disagreeing with the manifest is ambiguous
		expect(
			runnerPinFromConfig({
				runner_ref: ref,
				runner_sha256: SHA_C,
				runner_files: { 'box-runner.mjs': SHA_B },
			}),
		).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: ref, runner_files: [] })).toBeNull()
	})

	it('fetch script fetches and verifies every file into the same layout before installing', () => {
		const files = { 'box-runner.mjs': SHA_B, 'harness/claude.mjs': SHA_C }
		const script = runnerFetchScript({ ref, files })
		expect(script).toContain(runnerUrl(ref, 'harness/claude.mjs'))
		expect(script).toContain(runnerUrl(ref, 'box-runner.mjs'))
		expect(script).toContain(`'/opt/fermi/harness/claude.mjs'`)
		expect(script).toContain(`'/opt/fermi/box-runner.mjs'`)
		const lastVerify = script.lastIndexOf('sha256sum -c')
		const firstInstall = script.indexOf('mv ')
		expect(lastVerify).toBeGreaterThan(-1)
		expect(firstInstall).toBeGreaterThan(lastVerify)
		expect(script.match(/sha256sum -c/g)).toHaveLength(2)
	})

	it('fetch script throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref, files: { 'lib/x.mjs': SHA_C } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref, files: { 'box-runner.mjs': SHA_B, '../x': SHA_C } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref, files: { 'box-runner.mjs': 'zz' } })).toThrow()
	})
})

describe('pinRunner', () => {
	const ref = 'abc1234'
	const served: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/claude.mjs': 'export const h = 1',
		'lib/report.mjs': 'export const r = 1',
	}
	async function sha(text: string) {
		const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
		return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
	}
	function serve() {
		return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input instanceof Request ? input.url : input)
			const prefix = runnerUrl(ref, '')
			const path = url.startsWith(prefix) ? url.slice(prefix.length) : ''
			return path in served ? new Response(served[path]) : new Response('nope', { status: 404 })
		})
	}
	const stored = async () => JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('legacy body pins box-runner.mjs only and clears any manifest', async () => {
		serve()
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ region: 'eu-west-1', runner_files: { 'box-runner.mjs': SHA_B } }),
		)
		const out = await pinRunner(env, { ref })
		expect(out.status).toBe(200)
		const runnerSha = await sha(served['box-runner.mjs'])
		expect(out.body).toMatchObject({ ok: true, ref, sha256: runnerSha })
		const config = await stored()
		expect(config).toMatchObject({ region: 'eu-west-1', runner_ref: ref, runner_sha256: runnerSha })
		expect(config.runner_files).toBeNull()
		expect(runnerPinFromConfig(config)).toEqual({ ref, files: { 'box-runner.mjs': runnerSha } })
	})

	it('pins a manifest given as a list of paths', async () => {
		serve()
		const out = await pinRunner(env, { ref, files: Object.keys(served) })
		expect(out.status).toBe(200)
		const files: Record<string, string> = {}
		for (const [p, text] of Object.entries(served)) files[p] = await sha(text)
		expect(out.body).toMatchObject({ ok: true, files })
		expect(runnerPinFromConfig(await stored())).toEqual({ ref, files })
	})

	it('pins a { path: sha256 } manifest only when the ref serves those hashes', async () => {
		serve()
		const files: Record<string, string> = {}
		for (const [p, text] of Object.entries(served)) files[p] = await sha(text)
		expect((await pinRunner(env, { ref, files })).status).toBe(200)
		expect(runnerPinFromConfig(await stored())).toEqual({ ref, files })

		await env.FERMI_KV.delete('fleet:config')
		const wrong = await pinRunner(env, { ref, files: { ...files, 'lib/report.mjs': SHA_C } })
		expect(wrong.status).toBe(409)
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('fails closed when a manifest file is missing at the ref', async () => {
		serve()
		await env.FERMI_KV.delete('fleet:config')
		const out = await pinRunner(env, { ref, files: ['box-runner.mjs', 'lib/missing.mjs'] })
		expect(out.status).toBe(502)
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('rejects a bad ref or malformed files with 400', async () => {
		const fetchSpy = serve()
		for (const body of [
			{},
			{ ref: 'main' },
			{ ref: "abc1234'; rm" },
			{ ref, files: 'box-runner.mjs' },
			{ ref, files: [] },
			{ ref, files: ['lib/report.mjs'] },
			{ ref, files: ['box-runner.mjs', '../evil.mjs'] },
			{ ref, files: ['box-runner.mjs', 'box-runner.mjs'] },
			{ ref, files: ['box-runner.mjs', 42] },
			{ ref, files: { 'box-runner.mjs': 'nothex' } },
			{ ref, files: { 'lib/report.mjs': SHA_C } },
		]) {
			expect((await pinRunner(env, body)).status, JSON.stringify(body)).toBe(400)
		}
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})
