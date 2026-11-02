import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getFleetConfig, pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const SHA = 'b'.repeat(64)
const PIN = { ref: 'a'.repeat(40), files: { 'box-runner.mjs': SHA } }
const MANIFEST = {
	ref: 'a'.repeat(40),
	files: {
		'box-runner.mjs': '1'.repeat(64),
		'harness/claude.mjs': '2'.repeat(64),
		'lib/util.mjs': '3'.repeat(64),
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
		const verifyAt = script.indexOf('sha256sum -c')
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		expect(verifyAt).toBeGreaterThan(-1)
		expect(tokenAt).toBeGreaterThan(-1)
		expect(verifyAt).toBeLessThan(tokenAt)
	})

	it('user-data fetches and verifies every manifest file before the box token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(runnerUrl(MANIFEST.ref, path))
			expect(script).toContain(`/opt/fermi/${path}`)
			expect(script.indexOf(sha)).toBeGreaterThan(-1)
			expect(script.indexOf(sha)).toBeLessThan(tokenAt)
		}
		// Installs only after the single all-files hash check.
		expect(script.indexOf('sha256sum -c')).toBeLessThan(script.indexOf('mv '))
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		const ref = PIN.ref
		expect(() => runnerFetchScript({ ref, files: { 'lib/util.mjs': SHA } })).toThrow(/box-runner/)
		expect(() => runnerFetchScript({ ref, files: { 'box-runner.mjs': 'nothex' } })).toThrow()
		for (const path of ['../etc/passwd', '/abs.mjs', 'a//b.mjs', '.x/y.mjs', "it's.mjs"]) {
			expect(() =>
				runnerFetchScript({ ref, files: { 'box-runner.mjs': SHA, [path]: SHA } }),
			).toThrow(/unsafe path/)
		}
		expect(() => runnerFetchScript({ ref: "x'; rm -rf /", files: PIN.files })).toThrow()
	})

	it('runnerPinFromConfig reads legacy and manifest pins, null when unset or invalid', () => {
		expect(runnerPinFromConfig({ runner_ref: PIN.ref, runner_sha256: SHA })).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: PIN.ref, runner_sha256: null, runner_files: null }),
		).toBeNull()
		expect(
			runnerPinFromConfig({
				runner_ref: MANIFEST.ref,
				runner_sha256: MANIFEST.files['box-runner.mjs'],
				runner_files: MANIFEST.files,
			}),
		).toEqual(MANIFEST)
		expect(runnerPinFromConfig({ runner_ref: MANIFEST.ref, runner_files: MANIFEST.files })).toEqual(
			MANIFEST,
		)
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: SHA })).toBeNull()
		// Manifest without box-runner.mjs, unsafe path, or disagreeing legacy hash.
		expect(
			runnerPinFromConfig({ runner_ref: PIN.ref, runner_files: { 'lib/util.mjs': SHA } }),
		).toBeNull()
		expect(
			runnerPinFromConfig({
				runner_ref: PIN.ref,
				runner_files: { 'box-runner.mjs': SHA, '../x.mjs': SHA },
			}),
		).toBeNull()
		expect(
			runnerPinFromConfig({
				runner_ref: PIN.ref,
				runner_sha256: SHA,
				runner_files: MANIFEST.files,
			}),
		).toBeNull()
		// An invalid manifest never falls back to the legacy hash.
		expect(
			runnerPinFromConfig({ runner_ref: PIN.ref, runner_sha256: SHA, runner_files: 'nope' }),
		).toBeNull()
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

describe('pinRunner (#34 manifest)', () => {
	const REF = 'c'.repeat(40)
	const BODIES: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/claude.mjs': 'export const h = 1',
		'lib/util.mjs': 'export const u = 2',
	}
	const sha = async (s: string) =>
		[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
			.map((x) => x.toString(16).padStart(2, '0'))
			.join('')
	const serve = (paths: string[]) => {
		for (const p of paths)
			fetchMock
				.get('https://raw.githubusercontent.com')
				.intercept({ path: `/abel30567/fermi-daemon/${REF}/${p}` })
				.reply(200, BODIES[p])
	}

	beforeEach(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ default_env: 'node' }))
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	it('legacy single-file pin still works and clears any earlier manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'node', runner_files: { 'box-runner.mjs': SHA } }),
		)
		serve(['box-runner.mjs'])
		const out = await pinRunner(env, { ref: REF })
		const expected = await sha(BODIES['box-runner.mjs'])
		expect(out).toMatchObject({ status: 200, body: { ok: true, ref: REF, sha256: expected } })
		const config = await getFleetConfig(env)
		expect(config).toMatchObject({
			default_env: 'node',
			runner_ref: REF,
			runner_sha256: expected,
			runner_files: null,
		})
		expect(runnerPinFromConfig(config)).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': expected },
		})
	})

	it('pins a path list as a manifest, always including box-runner.mjs', async () => {
		serve(Object.keys(BODIES))
		const out = await pinRunner(env, { ref: REF, files: ['harness/claude.mjs', 'lib/util.mjs'] })
		const files = Object.fromEntries(
			await Promise.all(Object.entries(BODIES).map(async ([p, b]) => [p, await sha(b)])),
		)
		expect(out).toMatchObject({ status: 200, body: { ok: true, files } })
		expect(runnerPinFromConfig(await getFleetConfig(env))).toEqual({ ref: REF, files })
	})

	it('accepts a {path: sha256} manifest and refuses a hash that does not match', async () => {
		const files = Object.fromEntries(
			await Promise.all(Object.entries(BODIES).map(async ([p, b]) => [p, await sha(b)])),
		)
		serve(Object.keys(BODIES))
		expect(await pinRunner(env, { ref: REF, files })).toMatchObject({ status: 200 })
		expect(runnerPinFromConfig(await getFleetConfig(env))).toEqual({ ref: REF, files })

		await env.FERMI_KV.put('fleet:config', JSON.stringify({}))
		serve(Object.keys(BODIES))
		const out = await pinRunner(env, { ref: REF, files: { ...files, 'lib/util.mjs': SHA } })
		expect(out).toMatchObject({ status: 409, body: { ok: false, path: 'lib/util.mjs' } })
		expect((await getFleetConfig(env)).runner_ref).toBeNull()
	})

	it('502s without pinning when any file is missing upstream', async () => {
		serve(['box-runner.mjs'])
		fetchMock
			.get('https://raw.githubusercontent.com')
			.intercept({ path: `/abel30567/fermi-daemon/${REF}/lib/util.mjs` })
			.reply(404, 'nope')
		const out = await pinRunner(env, { ref: REF, files: ['lib/util.mjs'] })
		expect(out).toMatchObject({ status: 502, body: { ok: false, path: 'lib/util.mjs' } })
		expect((await getFleetConfig(env)).runner_ref).toBeNull()
	})

	it('400s on a bad ref or malformed files without fetching', async () => {
		for (const ref of [undefined, 'main', 'v1', "abc1234'"]) {
			expect((await pinRunner(env, { ref })).status).toBe(400)
		}
		for (const files of [
			null,
			'box-runner.mjs',
			42,
			[1],
			['../escape.mjs'],
			['/abs.mjs'],
			['lib/util.mjs', 'lib/util.mjs'],
			{},
			{ 'lib/util.mjs': SHA },
			{ 'box-runner.mjs': 'xyz' },
			{ 'box-runner.mjs': SHA, '../x.mjs': SHA },
		]) {
			expect((await pinRunner(env, { ref: REF, files })).status).toBe(400)
		}
		expect((await getFleetConfig(env)).runner_ref).toBeNull()
	})
})
