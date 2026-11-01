import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const REF = 'a'.repeat(40)
const SHA_RUNNER = 'b'.repeat(64)
const SHA_HARNESS = 'c'.repeat(64)
const PIN = { ref: REF, files: { 'box-runner.mjs': SHA_RUNNER } }
const MANIFEST_PIN = {
	ref: REF,
	files: { 'box-runner.mjs': SHA_RUNNER, 'harness/claude.mjs': SHA_HARNESS },
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
		expect(script).toContain(SHA_RUNNER)
		expect(script).not.toContain('/main/') // no floating branch
		expect(script).not.toContain('|| true') // fail closed, no baked-copy fallback
	})

	it('user-data verifies the runner BEFORE materializing the box token', () => {
		const script = userData()
		const verifyAt = script.indexOf(SHA_RUNNER)
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		expect(verifyAt).toBeGreaterThan(-1)
		expect(tokenAt).toBeGreaterThan(-1)
		expect(verifyAt).toBeLessThan(tokenAt)
	})

	it('user-data has no unpinned curl of main', () => {
		expect(userData()).not.toContain('fermi-daemon/main/')
	})

	it('manifest fetch script pins and verifies every file before the token exists', () => {
		const script = userData({ runnerPin: MANIFEST_PIN })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const [path, sha] of Object.entries(MANIFEST_PIN.files)) {
			expect(script).toContain(runnerUrl(REF, path))
			expect(script.indexOf(sha)).toBeGreaterThan(-1)
			expect(script.indexOf(sha)).toBeLessThan(tokenAt)
			expect(script).toContain(`/opt/fermi/${path}'`)
		}
		const checkAt = script.indexOf('sha256sum -c')
		const firstInstall = script.indexOf("mv '/opt/fermi/.runner-new/")
		expect(checkAt).toBeGreaterThan(-1)
		expect(checkAt).toBeLessThan(firstInstall)
	})

	it('runnerUrl defaults to box-runner.mjs and takes a path', () => {
		expect(runnerUrl(REF)).toBe(
			`https://raw.githubusercontent.com/abel30567/fermi-daemon/${REF}/box-runner.mjs`,
		)
		expect(runnerUrl(REF, 'lib/x.mjs')).toMatch(/\/lib\/x\.mjs$/)
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		const bad = [
			{ ref: REF, files: {} },
			{ ref: REF, files: { 'harness/claude.mjs': SHA_HARNESS } },
			{ ref: REF, files: { 'box-runner.mjs': 'nothex' } },
			{ ref: REF, files: { 'box-runner.mjs': SHA_RUNNER, '../etc/passwd': SHA_HARNESS } },
			{ ref: REF, files: { 'box-runner.mjs': SHA_RUNNER, "x';rm -rf /;'": SHA_HARNESS } },
			{ ref: "x'; reboot; '", files: { 'box-runner.mjs': SHA_RUNNER } },
		]
		for (const pin of bad) expect(() => runnerFetchScript(pin)).toThrow()
	})

	it('runnerPinFromConfig: legacy single-file pin, manifest, unset and invalid', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_RUNNER })).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_RUNNER, runner_files: null }),
		).toEqual(PIN)
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: SHA_RUNNER,
				runner_files: MANIFEST_PIN.files,
			}),
		).toEqual(MANIFEST_PIN)
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: MANIFEST_PIN.files })).toEqual(
			MANIFEST_PIN,
		)
		const invalid = [
			{},
			{ runner_ref: null, runner_sha256: null },
			{ runner_ref: REF, runner_sha256: null },
			{ runner_ref: REF, runner_sha256: 'short' },
			{ runner_ref: '../x', runner_sha256: SHA_RUNNER },
			{ runner_ref: REF, runner_files: { 'harness/claude.mjs': SHA_HARNESS } },
			{ runner_ref: REF, runner_files: { 'box-runner.mjs': SHA_RUNNER, '/abs.mjs': SHA_HARNESS } },
			{ runner_ref: REF, runner_files: { 'box-runner.mjs': SHA_RUNNER, 'a/../b': SHA_HARNESS } },
			{ runner_ref: REF, runner_files: ['box-runner.mjs'] },
			// manifest disagreeing with the legacy field fails closed
			{ runner_ref: REF, runner_sha256: SHA_HARNESS, runner_files: MANIFEST_PIN.files },
		]
		for (const c of invalid) expect(runnerPinFromConfig(c)).toBeNull()
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
	const RAW = 'https://raw.githubusercontent.com'
	const SHORT_REF = 'abc1234'
	const body = (p: string) => `content of ${p}`
	const shaOf = async (text: string) =>
		[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
			.map((x) => x.toString(16).padStart(2, '0'))
			.join('')
	const serve = (path: string, text = body(path)) =>
		fetchMock
			.get(RAW)
			.intercept({ path: `/abel30567/fermi-daemon/${SHORT_REF}/${path}` })
			.reply(200, text)
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

	it('legacy single-file pin still works and clears any manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'keep-me', runner_files: { 'box-runner.mjs': SHA_RUNNER } }),
		)
		serve('box-runner.mjs')
		const res = await pinRunner(env, { ref: SHORT_REF })
		const sha = await shaOf(body('box-runner.mjs'))
		expect(res).toMatchObject({ ok: true, status: 200, ref: SHORT_REF, sha256: sha })
		const cfg = await stored()
		expect(cfg).toMatchObject({
			default_env: 'keep-me',
			runner_ref: SHORT_REF,
			runner_sha256: sha,
			runner_files: null,
		})
		expect(runnerPinFromConfig(cfg)).toEqual({
			ref: SHORT_REF,
			files: { 'box-runner.mjs': sha },
		})
	})

	it('accepts a {path: sha256} manifest after verifying every file', async () => {
		const files = {
			'box-runner.mjs': await shaOf(body('box-runner.mjs')),
			'harness/claude.mjs': await shaOf(body('harness/claude.mjs')),
		}
		serve('box-runner.mjs')
		serve('harness/claude.mjs')
		const res = await pinRunner(env, { ref: SHORT_REF, files })
		expect(res).toMatchObject({ ok: true, status: 200, files })
		const cfg = await stored()
		expect(cfg).toMatchObject({
			runner_ref: SHORT_REF,
			runner_sha256: files['box-runner.mjs'],
			runner_files: files,
		})
		expect(runnerPinFromConfig(cfg)).toEqual({ ref: SHORT_REF, files })
	})

	it('accepts a path list and hashes each file', async () => {
		serve('box-runner.mjs')
		serve('lib/util.mjs')
		const res = await pinRunner(env, { ref: SHORT_REF, files: ['box-runner.mjs', 'lib/util.mjs'] })
		expect(res).toMatchObject({
			ok: true,
			files: {
				'box-runner.mjs': await shaOf(body('box-runner.mjs')),
				'lib/util.mjs': await shaOf(body('lib/util.mjs')),
			},
		})
	})

	it('refuses (and stores nothing) when a served file disagrees with the manifest', async () => {
		serve('box-runner.mjs')
		serve('harness/claude.mjs', 'tampered')
		const res = await pinRunner(env, {
			ref: SHORT_REF,
			files: {
				'box-runner.mjs': await shaOf(body('box-runner.mjs')),
				'harness/claude.mjs': await shaOf(body('harness/claude.mjs')),
			},
		})
		expect(res).toMatchObject({ ok: false, status: 409, path: 'harness/claude.mjs' })
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})

	it('400 on a bad ref or a malformed files', async () => {
		const bad: { ref?: unknown; files?: unknown }[] = [
			{},
			{ ref: 'main' },
			{ ref: "abc1234'; reboot" },
			{ ref: SHORT_REF, files: 'box-runner.mjs' },
			{ ref: SHORT_REF, files: {} },
			{ ref: SHORT_REF, files: [] },
			{ ref: SHORT_REF, files: ['harness/claude.mjs'] },
			{ ref: SHORT_REF, files: ['box-runner.mjs', '../secret'] },
			{ ref: SHORT_REF, files: ['box-runner.mjs', 'box-runner.mjs'] },
			{ ref: SHORT_REF, files: { 'harness/claude.mjs': SHA_HARNESS } },
			{ ref: SHORT_REF, files: { 'box-runner.mjs': 'nothex' } },
			{ ref: SHORT_REF, files: { 'box-runner.mjs': SHA_RUNNER, '/etc/x': SHA_HARNESS } },
		]
		for (const b of bad) expect(await pinRunner(env, b)).toMatchObject({ ok: false, status: 400 })
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})
})
