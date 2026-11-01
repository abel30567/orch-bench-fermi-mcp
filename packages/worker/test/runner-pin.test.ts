import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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
		'harness/index.mjs': 'c'.repeat(64),
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

	it('legacy single-file config is a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: PIN.ref, runner_sha256: SHA })).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: PIN.ref, runner_sha256: SHA, runner_files: null }),
		).toEqual(PIN)
	})

	it('reads a multi-file manifest and rejects invalid ones', () => {
		const cfg = { runner_ref: MANIFEST.ref, runner_sha256: SHA, runner_files: MANIFEST.files }
		expect(runnerPinFromConfig(cfg)).toEqual(MANIFEST)
		expect(runnerPinFromConfig({ ...cfg, runner_sha256: undefined })).toEqual(MANIFEST)
		expect(runnerPinFromConfig({})).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: SHA })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: 'x', runner_sha256: 'nothex' })).toBeNull()
		// manifest must contain box-runner.mjs
		expect(runnerPinFromConfig({ runner_ref: 'x', runner_files: { 'lib/a.mjs': SHA } })).toBeNull()
		// unsafe paths
		for (const bad of [
			'../evil.mjs',
			'/etc/passwd',
			'lib/../x',
			"a'b.mjs",
			'a b.mjs',
			'lib//a',
			'.hidden',
			'a$(x)',
		]) {
			expect(
				runnerPinFromConfig({
					runner_ref: 'x',
					runner_files: { 'box-runner.mjs': SHA, [bad]: SHA },
				}),
			).toBeNull()
		}
		// bad hash in manifest
		expect(
			runnerPinFromConfig({
				runner_ref: 'x',
				runner_files: { 'box-runner.mjs': SHA, 'lib/a.mjs': 'z' },
			}),
		).toBeNull()
		// runner_sha256 disagreeing with the manifest entry
		expect(runnerPinFromConfig({ ...cfg, runner_sha256: 'e'.repeat(64) })).toBeNull()
		// unsafe ref
		expect(runnerPinFromConfig({ runner_ref: "a'; rm -rf /", runner_sha256: SHA })).toBeNull()
	})

	it('fetch script fetches and verifies every manifest file before installing any', () => {
		const script = runnerFetchScript(MANIFEST)
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(runnerUrl(MANIFEST.ref, path))
			expect(script).toContain(`${sha}  /opt/fermi/.runner-staging/${path}`)
			expect(script).toContain(`mv '/opt/fermi/.runner-staging/${path}' '/opt/fermi/${path}'`)
		}
		const lastVerify = script.lastIndexOf('FERMI_RUNNER_PIN')
		expect(lastVerify).toBeLessThan(script.indexOf('mv '))
		expect(script).not.toContain('|| true')
	})

	it('fetch script throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: 'x', files: { 'lib/a.mjs': SHA } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: 'x', files: { 'box-runner.mjs': SHA, '../x': SHA } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: 'x', files: {} })).toThrow()
	})

	it('user-data verifies every manifest file before the box token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const sha of Object.values(MANIFEST.files)) {
			expect(script.indexOf(sha)).toBeGreaterThan(-1)
			expect(script.indexOf(sha)).toBeLessThan(tokenAt)
		}
	})

	it('dispatchProvision refuses launch on an invalid manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: 'a'.repeat(40),
				runner_sha256: SHA,
				runner_files: { 'lib/a.mjs': SHA },
			}),
		)
		const out = await dispatchProvision(env, {
			id: 'ca_badpin',
			box_id: null,
		} as unknown as CloudAgentRow)
		expect(out).toEqual({ dispatched: false, reason: 'runner_pin_unset' })
	})
})

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	const REF = 'abcdef1234567'
	const ORIGIN = 'https://raw.githubusercontent.com'
	const base = `/abel30567/fermi-daemon/${REF}`
	const sha = async (s: string) => {
		const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
		return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
	}
	const serve = (path: string, body: string) =>
		fetchMock
			.get(ORIGIN)
			.intercept({ path: `${base}/${path}` })
			.reply(200, body)

	beforeAll(() => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	afterEach(() => fetchMock.assertNoPendingInterceptors())

	it('rejects a bad ref and malformed files with 400', async () => {
		expect((await pinRunner(env, { ref: 'main' })).status).toBe(400)
		expect((await pinRunner(env, {})).status).toBe(400)
		for (const files of [
			'box-runner.mjs',
			[],
			['../x'],
			{ 'lib/a.mjs': SHA },
			{ 'box-runner.mjs': 'nothex' },
			{ 'box-runner.mjs': SHA, '/abs': SHA },
			42,
		]) {
			expect((await pinRunner(env, { ref: REF, files })).status).toBe(400)
		}
	})

	it('legacy single-file pin still writes runner_ref + runner_sha256', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'keep', runner_files: { x: 1 } }),
		)
		serve('box-runner.mjs', 'runner')
		const res = await pinRunner(env, { ref: REF })
		expect(res).toMatchObject({
			status: 200,
			body: { ok: true, ref: REF, sha256: await sha('runner') },
		})
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(stored).toMatchObject({
			default_env: 'keep',
			runner_ref: REF,
			runner_sha256: await sha('runner'),
			runner_files: null,
		})
		expect(runnerPinFromConfig(stored)).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': await sha('runner') },
		})
	})

	it('pins a manifest from a path list (box-runner.mjs always included)', async () => {
		serve('box-runner.mjs', 'runner')
		serve('harness/index.mjs', 'harness')
		const res = await pinRunner(env, { ref: REF, files: ['harness/index.mjs'] })
		const files = {
			'box-runner.mjs': await sha('runner'),
			'harness/index.mjs': await sha('harness'),
		}
		expect(res).toMatchObject({ status: 200, body: { ok: true, files } })
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(runnerPinFromConfig(stored)).toEqual({ ref: REF, files })
	})

	it('accepts a {path: sha256} manifest and refuses when a fetched hash differs', async () => {
		const files = { 'box-runner.mjs': await sha('runner'), 'lib/util.mjs': await sha('util') }
		serve('box-runner.mjs', 'runner')
		serve('lib/util.mjs', 'util')
		expect(await pinRunner(env, { ref: REF, files })).toMatchObject({
			status: 200,
			body: { files },
		})

		await env.FERMI_KV.put('fleet:config', '{}')
		serve('box-runner.mjs', 'runner')
		serve('lib/util.mjs', 'tampered')
		expect(await pinRunner(env, { ref: REF, files })).toMatchObject({
			status: 409,
			body: { error: 'sha256_mismatch', path: 'lib/util.mjs' },
		})
		expect(await env.FERMI_KV.get('fleet:config')).toBe('{}')
	})

	it('a missing file fails the pin and writes nothing', async () => {
		await env.FERMI_KV.put('fleet:config', '{}')
		serve('box-runner.mjs', 'runner')
		fetchMock
			.get(ORIGIN)
			.intercept({ path: `${base}/lib/gone.mjs` })
			.reply(404, 'nope')
		expect(await pinRunner(env, { ref: REF, files: ['lib/gone.mjs'] })).toMatchObject({
			status: 502,
			body: { error: 'fetch_404', path: 'lib/gone.mjs' },
		})
		expect(await env.FERMI_KV.get('fleet:config')).toBe('{}')
	})
})
