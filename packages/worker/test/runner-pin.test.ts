import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const SHA = 'b'.repeat(64)
const PIN = { ref: 'a'.repeat(40), files: { 'box-runner.mjs': SHA } }

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
		expect(script).toContain(SHA)
		expect(script).not.toContain('/main/') // no floating branch
		expect(script).not.toContain('|| true') // fail closed, no baked-copy fallback
	})

	it('user-data verifies the runner BEFORE materializing the box token', () => {
		const script = userData()
		const verifyAt = script.indexOf(SHA)
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
})

const H = (c: string) => c.repeat(64)
const MANIFEST = {
	'box-runner.mjs': H('1'),
	'harness/claude.mjs': H('2'),
	'lib/util.mjs': H('3'),
}

describe('runner pin manifest (pr-55)', () => {
	it('runnerPinFromConfig: legacy single-file pin becomes a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: 'abc1234', runner_sha256: SHA })).toEqual({
			ref: 'abc1234',
			files: { 'box-runner.mjs': SHA },
		})
		expect(
			runnerPinFromConfig({ runner_ref: 'abc1234', runner_sha256: SHA, runner_files: null }),
		).toEqual({ ref: 'abc1234', files: { 'box-runner.mjs': SHA } })
	})

	it('legacy single-file pin still boots: same URL, same install path, hash verified', () => {
		const pin = runnerPinFromConfig({ runner_ref: 'a'.repeat(40), runner_sha256: SHA })
		expect(pin).not.toBeNull()
		const script = runnerFetchScript(pin as NonNullable<typeof pin>)
		expect(script).toContain(`'${runnerUrl('a'.repeat(40))}'`)
		expect(script).toContain(`${SHA}  /opt/fermi/.runner-new/box-runner.mjs`)
		expect(script).toContain(
			"mv '/opt/fermi/.runner-new/box-runner.mjs' '/opt/fermi/box-runner.mjs'",
		)
	})

	it('runnerPinFromConfig: manifest wins over runner_sha256', () => {
		expect(
			runnerPinFromConfig({ runner_ref: 'abc1234', runner_sha256: SHA, runner_files: MANIFEST }),
		).toEqual({ ref: 'abc1234', files: MANIFEST })
	})

	it('runnerPinFromConfig: null when unset or invalid', () => {
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: 'abc1234', runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: 'abc1234', runner_sha256: 'nothex' })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: "x'; rm -rf /", runner_sha256: SHA })).toBeNull()
		// manifest without box-runner.mjs
		expect(
			runnerPinFromConfig({ runner_ref: 'abc1234', runner_files: { 'lib/util.mjs': H('3') } }),
		).toBeNull()
		// unsafe paths
		for (const bad of ['../x.mjs', '/etc/passwd', 'lib/../x', 'lib//x', '.hidden', "a'b", '']) {
			expect(
				runnerPinFromConfig({
					runner_ref: 'abc1234',
					runner_files: { 'box-runner.mjs': SHA, [bad]: H('4') },
				}),
			).toBeNull()
		}
		// malformed hash in a manifest; malformed manifest shape
		expect(
			runnerPinFromConfig({ runner_ref: 'abc1234', runner_files: { 'box-runner.mjs': 'b' } }),
		).toBeNull()
		expect(
			runnerPinFromConfig({ runner_ref: 'abc1234', runner_files: ['box-runner.mjs'] }),
		).toBeNull()
	})

	it('runnerFetchScript fetches every file at the ref, verifies all before installing any', () => {
		const script = runnerFetchScript({ ref: 'abc1234', files: MANIFEST })
		const lines = script.split('\n')
		for (const [path, sha] of Object.entries(MANIFEST)) {
			expect(script).toContain(`'${runnerUrl('abc1234', path)}'`)
			expect(script).toContain(`${sha}  /opt/fermi/.runner-new/${path}`)
			expect(script).toContain(`mv '/opt/fermi/.runner-new/${path}' '/opt/fermi/${path}'`)
		}
		const lastVerify = Math.max(...lines.flatMap((l, i) => (l.includes('sha256sum') ? [i] : [])))
		const firstMv = lines.findIndex((l) => l.startsWith('mv '))
		expect(lastVerify).toBeLessThan(firstMv)
		expect(script).not.toContain('|| true')
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: 'abc1234', files: { 'lib/util.mjs': H('3') } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: 'abc1234', files: { 'box-runner.mjs': SHA, '../evil': H('4') } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: 'abc1234', files: { 'box-runner.mjs': 'zz' } })).toThrow()
	})

	it('user-data verifies every manifest file BEFORE materializing the box token', () => {
		const script = userData({ runnerPin: { ref: 'abc1234', files: MANIFEST } })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const sha of Object.values(MANIFEST)) {
			const at = script.indexOf(sha)
			expect(at).toBeGreaterThan(-1)
			expect(at).toBeLessThan(tokenAt)
		}
	})
})

describe('pinRunner (pr-55)', () => {
	const REF = 'c'.repeat(40)
	const BODIES: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/claude.mjs': 'export const h = 1',
		'lib/util.mjs': 'export const u = 1',
	}
	async function sha(text: string) {
		const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
		return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
	}
	const serve = (path: string, status = 200, body = BODIES[path]) =>
		fetchMock
			.get('https://raw.githubusercontent.com')
			.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}` })
			.reply(status, body)
	const stored = async () => JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')

	beforeEach(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ region: 'us-west-2' }))
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	it('legacy {ref} pins box-runner.mjs and clears any manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ region: 'us-west-2', runner_files: { 'box-runner.mjs': SHA } }),
		)
		serve('box-runner.mjs')
		const res = await pinRunner(env, { ref: REF })
		const want = await sha(BODIES['box-runner.mjs'])
		expect(res.status).toBe(200)
		expect(res.body).toMatchObject({ ok: true, ref: REF, sha256: want })
		expect(await stored()).toEqual({
			region: 'us-west-2',
			runner_ref: REF,
			runner_sha256: want,
			runner_files: null,
		})
		expect(runnerPinFromConfig(await stored())).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': want },
		})
	})

	it('{ref, files} fetches and verifies every file, then stores the manifest', async () => {
		const files: Record<string, string> = {}
		for (const p of Object.keys(BODIES)) {
			files[p] = await sha(BODIES[p])
			serve(p)
		}
		const res = await pinRunner(env, { ref: REF, files })
		expect(res.status).toBe(200)
		expect(res.body).toMatchObject({ ok: true, ref: REF, files, sha256: files['box-runner.mjs'] })
		const cfg = await stored()
		expect(cfg).toMatchObject({
			region: 'us-west-2',
			runner_ref: REF,
			runner_sha256: files['box-runner.mjs'],
			runner_files: files,
		})
		expect(runnerPinFromConfig(cfg)).toEqual({ ref: REF, files })
	})

	it('refuses a manifest whose declared hash does not match the ref, storing nothing', async () => {
		serve('box-runner.mjs')
		serve('lib/util.mjs')
		const res = await pinRunner(env, {
			ref: REF,
			files: { 'box-runner.mjs': await sha(BODIES['box-runner.mjs']), 'lib/util.mjs': H('9') },
		})
		expect(res.status).toBe(409)
		expect(res.body).toMatchObject({ ok: false, error: 'sha256_mismatch', path: 'lib/util.mjs' })
		expect(await stored()).toEqual({ region: 'us-west-2' })
	})

	it('a file missing at the ref is a 502 and stores nothing', async () => {
		serve('box-runner.mjs')
		serve('lib/util.mjs', 404, 'nope')
		const res = await pinRunner(env, {
			ref: REF,
			files: { 'box-runner.mjs': await sha(BODIES['box-runner.mjs']), 'lib/util.mjs': H('3') },
		})
		expect(res.status).toBe(502)
		expect(await stored()).toEqual({ region: 'us-west-2' })
	})

	it('400 on a bad ref or a malformed files manifest (no fetch)', async () => {
		for (const ref of [undefined, '', 'main', 'v1', 'x'.repeat(40)])
			expect((await pinRunner(env, { ref })).status).toBe(400)
		for (const files of [
			null,
			[],
			'box-runner.mjs',
			{},
			{ 'lib/util.mjs': H('3') },
			{ 'box-runner.mjs': 'short' },
			{ 'box-runner.mjs': H('1'), '../x': H('2') },
			{ 'box-runner.mjs': H('1'), 'lib/x': 5 },
		])
			expect((await pinRunner(env, { ref: REF, files })).status).toBe(400)
		expect(await stored()).toEqual({ region: 'us-west-2' })
	})
})
