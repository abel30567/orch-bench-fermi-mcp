import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getFleetConfig, pinRunner, validateFleetConfigPatch } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import {
	MAX_RUNNER_FILES,
	type RunnerPin,
	runnerFetchScript,
	runnerPinFromConfig,
	runnerUrl,
} from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)
const REF = 'a'.repeat(40)
const PIN: RunnerPin = {
	ref: REF,
	files: { 'box-runner.mjs': SHA_B, 'harness/claude.mjs': SHA_C, 'lib/util.mjs': SHA_A },
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
		for (const [path, sha256] of Object.entries(PIN.files)) {
			expect(script).toContain(runnerUrl(PIN.ref, path))
			expect(script).toContain(sha256)
		}
		expect(script).not.toContain('/main/') // no floating branch
		expect(script).not.toContain('|| true') // fail closed, no baked-copy fallback
	})

	it('fetch script verifies every file before installing any of them', () => {
		const script = runnerFetchScript(PIN)
		const firstInstall = script.indexOf('mv ')
		expect(firstInstall).toBeGreaterThan(-1)
		for (const sha256 of Object.values(PIN.files)) {
			expect(script.indexOf(sha256)).toBeLessThan(firstInstall)
		}
		expect(script).toContain("/opt/fermi/lib/util.mjs'")
		expect(script).toContain("/opt/fermi/box-runner.mjs'")
	})

	it('fetch script throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: REF, files: {} })).toThrow()
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/a.mjs': SHA_A } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': SHA_A, '../evil.mjs': SHA_B } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: "x'; reboot #", files: PIN.files })).toThrow()
	})

	it('runnerUrl defaults to the entry file and takes a relative path', () => {
		expect(runnerUrl('abc')).toMatch(/\/fermi-daemon\/abc\/box-runner\.mjs$/)
		expect(runnerUrl('abc', 'lib/util.mjs')).toMatch(/\/fermi-daemon\/abc\/lib\/util\.mjs$/)
	})

	it('user-data verifies every file BEFORE materializing the box token', () => {
		const script = userData()
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		expect(tokenAt).toBeGreaterThan(-1)
		for (const sha256 of Object.values(PIN.files)) {
			const verifyAt = script.indexOf(sha256)
			expect(verifyAt).toBeGreaterThan(-1)
			expect(verifyAt).toBeLessThan(tokenAt)
		}
	})

	it('a maximum-size manifest fits the 16 KB EC2 user-data limit', () => {
		const paths = Array.from({ length: MAX_RUNNER_FILES - 1 }, (_, i) => `harness/mod-${i}.mjs`)
		const files = { 'box-runner.mjs': SHA_A, ...Object.fromEntries(paths.map((p) => [p, SHA_B])) }
		expect(userData({ runnerPin: { ref: REF, files } }).length).toBeLessThan(16_384)
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

	it('dispatchProvision refuses launch when the stored manifest is corrupt', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: REF,
				runner_sha256: SHA_A,
				runner_files: { 'lib/util.mjs': SHA_B },
			}),
		)
		const agent = { id: 'ca_corrupt', ttl_seconds: 3600 } as unknown as CloudAgentRow
		const out = await dispatchProvision(env, agent)
		expect(out).toEqual({ dispatched: false, reason: 'runner_pin_unset' })
	})
})

describe('runnerPinFromConfig', () => {
	it('turns a legacy single-file pin into a one-entry manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: SHA_A })).toEqual({
			ref: 'v1',
			files: { 'box-runner.mjs': SHA_A },
		})
	})

	it('reads a manifest, which wins over the single hash', () => {
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_A, runner_files: PIN.files }),
		).toEqual(PIN)
	})

	it('is null when unset', () => {
		expect(runnerPinFromConfig({})).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: SHA_A })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_files: PIN.files })).toBeNull()
	})

	it('never falls back to the single hash when the manifest is invalid', () => {
		for (const runner_files of [{}, [], 'x', { 'lib/a.mjs': SHA_A }]) {
			expect(
				runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_A, runner_files }),
			).toBeNull()
		}
	})

	it.each([
		'../evil.mjs',
		'lib/../../evil.mjs',
		'/etc/passwd',
		'lib//a.mjs',
		'lib/',
		'./a.mjs',
		'.ssh/authorized_keys',
		"a'.mjs",
		'a b.mjs',
		'$(reboot).mjs',
		'a\n.mjs',
		'lib\\a.mjs',
		'%2e%2e/a.mjs',
	])('rejects the unsafe path %j', (path) => {
		const runner_files = { 'box-runner.mjs': SHA_A, [path]: SHA_B }
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files })).toBeNull()
	})

	it('rejects a bad hash, a path that is also a directory and an oversized manifest', () => {
		const pin = (runner_files: unknown) => runnerPinFromConfig({ runner_ref: REF, runner_files })
		expect(pin({ 'box-runner.mjs': 'abc' })).toBeNull()
		expect(pin({ 'box-runner.mjs': SHA_A.toUpperCase() })).toBeNull()
		expect(pin({ 'box-runner.mjs': SHA_A, lib: SHA_B, 'lib/a.mjs': SHA_C })).toBeNull()
		const many = Array.from({ length: MAX_RUNNER_FILES }, (_, i) => [`lib/${i}.mjs`, SHA_B])
		expect(pin({ 'box-runner.mjs': SHA_A, ...Object.fromEntries(many) })).toBeNull()
	})
})

describe('pinRunner', () => {
	const COMMIT = 'c'.repeat(40)
	const ORIGIN = 'https://raw.githubusercontent.com'
	const serve = (path: string, status: number, body: string) =>
		fetchMock
			.get(ORIGIN)
			.intercept({ path: `/abel30567/fermi-daemon/${COMMIT}/${path}` })
			.reply(status, body)
	const sha256 = async (text: string) => {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
		return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
	}

	beforeEach(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ region: 'eu-west-1' }))
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	it('legacy: fetches and hashes box-runner.mjs alone', async () => {
		serve('box-runner.mjs', 200, 'runner')
		const out = await pinRunner(env, { ref: COMMIT })
		const hash = await sha256('runner')
		expect(out.status).toBe(200)
		expect(out.body).toMatchObject({ ok: true, ref: COMMIT, sha256: hash, bytes: 6 })
		const config = await getFleetConfig(env)
		expect(config).toMatchObject({ region: 'eu-west-1', runner_sha256: hash, runner_files: null })
		expect(runnerPinFromConfig(config)?.files).toEqual({ 'box-runner.mjs': hash })
	})

	it('manifest: stores every file once all of them match', async () => {
		serve('box-runner.mjs', 200, 'runner')
		serve('lib/util.mjs', 200, 'util')
		const files = {
			'box-runner.mjs': await sha256('runner'),
			'lib/util.mjs': await sha256('util'),
		}
		const out = await pinRunner(env, { ref: COMMIT, files })
		expect(out.status).toBe(200)
		const config = await getFleetConfig(env)
		expect(config.runner_sha256).toBe(files['box-runner.mjs'])
		expect(runnerPinFromConfig(config)).toEqual({ ref: COMMIT, files })
	})

	it('a later single-file pin clears the previous manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ runner_ref: REF, runner_sha256: SHA_A, runner_files: PIN.files }),
		)
		serve('box-runner.mjs', 200, 'runner')
		await pinRunner(env, { ref: COMMIT })
		expect(runnerPinFromConfig(await getFleetConfig(env))).toEqual({
			ref: COMMIT,
			files: { 'box-runner.mjs': await sha256('runner') },
		})
	})

	it.each([
		['no ref', {}],
		['a null body', null],
		['a branch ref', { ref: 'main' }],
		['null files', { ref: COMMIT, files: null }],
		['an array', { ref: COMMIT, files: ['box-runner.mjs'] }],
		['empty files', { ref: COMMIT, files: {} }],
		['no entry file', { ref: COMMIT, files: { 'lib/util.mjs': SHA_A } }],
		['an unsafe path', { ref: COMMIT, files: { 'box-runner.mjs': SHA_A, '../x': SHA_B } }],
		['a bad hash', { ref: COMMIT, files: { 'box-runner.mjs': 'nope' } }],
	])('400 on %s, with no fetch and no write', async (_label, input) => {
		const before = await env.FERMI_KV.get('fleet:config')
		expect((await pinRunner(env, input)).status).toBe(400)
		expect(await env.FERMI_KV.get('fleet:config')).toBe(before)
	})

	it('refuses a manifest whose hash differs from the file at the ref, pinning nothing', async () => {
		serve('box-runner.mjs', 200, 'runner')
		serve('lib/util.mjs', 200, 'not what was pinned')
		const before = await env.FERMI_KV.get('fleet:config')
		const files = { 'box-runner.mjs': await sha256('runner'), 'lib/util.mjs': SHA_A }
		const out = await pinRunner(env, { ref: COMMIT, files })
		expect(out.status).toBe(409)
		expect(out.body).toMatchObject({ ok: false, error: 'hash_mismatch', path: 'lib/util.mjs' })
		expect(await env.FERMI_KV.get('fleet:config')).toBe(before)
	})

	it('refuses a manifest with a file missing at the ref, pinning nothing', async () => {
		serve('box-runner.mjs', 200, 'runner')
		serve('lib/util.mjs', 404, 'nope')
		const before = await env.FERMI_KV.get('fleet:config')
		const files = { 'box-runner.mjs': await sha256('runner'), 'lib/util.mjs': SHA_A }
		const out = await pinRunner(env, { ref: COMMIT, files })
		expect(out.status).toBe(502)
		expect(out.body).toMatchObject({ ok: false, error: 'fetch_404', path: 'lib/util.mjs' })
		expect(await env.FERMI_KV.get('fleet:config')).toBe(before)
	})

	it('the manifest is not editable through the fleet config endpoint', async () => {
		const config = await getFleetConfig(env)
		expect(validateFleetConfigPatch(config, { runner_files: PIN.files })).toMatchObject({
			ok: false,
		})
	})
})
