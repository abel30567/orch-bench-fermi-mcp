import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const SHA = 'b'.repeat(64)
const PIN = { ref: 'a'.repeat(40), files: { 'box-runner.mjs': SHA } }
const MANIFEST = {
	ref: 'a'.repeat(40),
	files: {
		'box-runner.mjs': SHA,
		'harness/claude.mjs': 'c'.repeat(64),
		'lib/util.mjs': 'd'.repeat(64),
	},
}

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

	it('dispatchProvision refuses launch when the manifest lacks box-runner.mjs', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: 'a'.repeat(40),
				runner_sha256: SHA,
				runner_files: { 'lib/util.mjs': SHA },
			}),
		)
		const out = await dispatchProvision(env, {
			id: 'ca_badmanifest',
			queue: 'default',
			route: 'claude',
			box_id: null,
			ttl_seconds: 3600,
		} as unknown as CloudAgentRow)
		expect(out).toEqual({ dispatched: false, reason: 'runner_pin_unset' })
	})
})

describe('runner pin manifest', () => {
	it('legacy single-file config becomes a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: SHA })).toEqual({
			ref: 'v1',
			files: { 'box-runner.mjs': SHA },
		})
		expect(
			runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: SHA, runner_files: null }),
		).toEqual({ ref: 'v1', files: { 'box-runner.mjs': SHA } })
	})

	it('manifest config wins over runner_sha256', () => {
		expect(
			runnerPinFromConfig({
				runner_ref: MANIFEST.ref,
				runner_sha256: SHA,
				runner_files: MANIFEST.files,
			}),
		).toEqual(MANIFEST)
	})

	it('unset or invalid pins are null', () => {
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: SHA })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: 'nothex' })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: "v1'; rm -rf /", runner_sha256: SHA })).toBeNull()
		// manifest without box-runner.mjs
		expect(runnerPinFromConfig({ runner_ref: 'v1', runner_files: { 'lib/a.mjs': SHA } })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: 'v1', runner_files: {} })).toBeNull()
		for (const bad of [
			'../x.mjs',
			'/etc/passwd',
			'lib/../../x',
			'lib//x',
			"a'b.mjs",
			'a b.mjs',
			'./x',
		]) {
			expect(
				runnerPinFromConfig({
					runner_ref: 'v1',
					runner_files: { 'box-runner.mjs': SHA, [bad]: SHA },
				}),
			).toBeNull()
		}
		expect(
			runnerPinFromConfig({ runner_ref: 'v1', runner_files: { 'box-runner.mjs': 'x'.repeat(64) } }),
		).toBeNull()
	})

	it('fetch script fetches and verifies every file into the same layout before installing', () => {
		const script = runnerFetchScript(MANIFEST)
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(runnerUrl(MANIFEST.ref, path))
			expect(script).toContain(sha)
			expect(script).toContain(`/opt/fermi/${path}'`)
		}
		const lastVerify = script.lastIndexOf('sha256sum -c')
		const firstInstall = script.indexOf('mv ')
		expect(lastVerify).toBeGreaterThan(-1)
		expect(firstInstall).toBeGreaterThan(lastVerify)
	})

	it('fetch script throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: 'v1', files: { 'lib/a.mjs': SHA } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: 'v1', files: { 'box-runner.mjs': SHA, '../evil': SHA } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: '../main', files: { 'box-runner.mjs': SHA } })).toThrow()
	})

	it('user-data verifies every manifest file before the box token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const sha of Object.values(MANIFEST.files)) {
			const at = script.indexOf(sha)
			expect(at).toBeGreaterThan(-1)
			expect(at).toBeLessThan(tokenAt)
		}
	})
})

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	const REF = 'abcdef1234567'
	const ORIGIN = 'https://raw.githubusercontent.com'
	const base = `/abel30567/fermi-daemon/${REF}`
	const BODIES: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/claude.mjs': 'export const h = 1',
		'lib/util.mjs': 'export const u = 1',
	}
	const hex = async (s: string) =>
		[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
			.map((x) => x.toString(16).padStart(2, '0'))
			.join('')
	const serve = (path: string) =>
		fetchMock
			.get(ORIGIN)
			.intercept({ path: `${base}/${path}` })
			.reply(200, BODIES[path])
	const stored = async () => JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')

	beforeEach(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ default_env: 'keep-me' }))
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	it('legacy single-file pin still works', async () => {
		serve('box-runner.mjs')
		const res = await pinRunner(env, { ref: REF })
		expect(res.status).toBe(200)
		const sha = await hex(BODIES['box-runner.mjs'])
		expect(await res.json()).toMatchObject({ ok: true, ref: REF, sha256: sha })
		const cfg = await stored()
		expect(cfg).toMatchObject({ default_env: 'keep-me', runner_ref: REF, runner_sha256: sha })
		expect(runnerPinFromConfig(cfg)).toEqual({ ref: REF, files: { 'box-runner.mjs': sha } })
	})

	it('accepts a { path: sha256 } manifest, verifying each file', async () => {
		for (const p of Object.keys(BODIES)) serve(p)
		const files = Object.fromEntries(
			await Promise.all(Object.entries(BODIES).map(async ([p, b]) => [p, await hex(b)])),
		)
		const res = await pinRunner(env, { ref: REF, files })
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ ok: true, files })
		expect(runnerPinFromConfig(await stored())).toEqual({ ref: REF, files })
	})

	it('accepts a list of paths and hashes each (box-runner.mjs implied)', async () => {
		for (const p of Object.keys(BODIES)) serve(p)
		const res = await pinRunner(env, { ref: REF, files: ['harness/claude.mjs', 'lib/util.mjs'] })
		expect(res.status).toBe(200)
		const pin = runnerPinFromConfig(await stored())
		expect(Object.keys(pin?.files ?? {}).sort()).toEqual(Object.keys(BODIES).sort())
		expect(pin?.files['lib/util.mjs']).toBe(await hex(BODIES['lib/util.mjs']))
	})

	it('refuses a manifest whose hash does not match upstream, leaving the pin untouched', async () => {
		serve('box-runner.mjs')
		const res = await pinRunner(env, { ref: REF, files: { 'box-runner.mjs': 'e'.repeat(64) } })
		expect(res.status).toBe(409)
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})

	it('400 on a bad ref or malformed files', async () => {
		const cases: unknown[] = [
			{ ref: 'main' },
			{ ref: undefined },
			{ ref: REF, files: 'box-runner.mjs' },
			{ ref: REF, files: [] },
			{ ref: REF, files: ['../etc/passwd'] },
			{ ref: REF, files: [42] },
			{ ref: REF, files: {} },
			{ ref: REF, files: { 'lib/util.mjs': 'a'.repeat(64) } },
			{ ref: REF, files: { 'box-runner.mjs': 'nothex' } },
			{ ref: REF, files: { 'box-runner.mjs': 'a'.repeat(64), '/abs.mjs': 'a'.repeat(64) } },
		]
		for (const body of cases) {
			const res = await pinRunner(env, body as { ref?: unknown; files?: unknown })
			expect(res.status, JSON.stringify(body)).toBe(400)
		}
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})
})
