import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const REF = 'a'.repeat(40)
const SHA = 'b'.repeat(64)
const PIN = { ref: REF, files: { 'box-runner.mjs': SHA } }
const MANIFEST = {
	ref: REF,
	files: {
		'box-runner.mjs': SHA,
		'harness/claude.mjs': 'c'.repeat(64),
		'lib/util.mjs': 'd'.repeat(64),
	},
}

async function sha256Of(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function serveDaemon(ref: string, files: Record<string, string>) {
	for (const [path, body] of Object.entries(files)) {
		fetchMock
			.get('https://raw.githubusercontent.com')
			.intercept({ path: `/abel30567/fermi-daemon/${ref}/${path}` })
			.reply(200, body)
	}
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

	it('fetch script fetches and verifies every manifest file, all before the box token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(runnerUrl(REF, path))
			expect(script.indexOf(sha)).toBeGreaterThan(-1)
			expect(script.indexOf(sha)).toBeLessThan(tokenAt)
			expect(script).toContain(`'/opt/fermi/${path}'`)
		}
		// Every hash is checked before anything is installed.
		const lastVerify = Math.max(...Object.values(MANIFEST.files).map((h) => script.indexOf(h)))
		expect(lastVerify).toBeLessThan(script.indexOf('mv '))
	})

	it('fetch script throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/util.mjs': SHA } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': SHA, '../evil.mjs': SHA } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': 'nothex' } })).toThrow()
		expect(() => runnerFetchScript({ ref: "x'; rm -rf /", files: PIN.files })).toThrow()
	})

	it('runnerPinFromConfig reads a legacy single-file pin', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA })).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: SHA, runner_files: null }),
		).toEqual({ ref: 'v1', files: { 'box-runner.mjs': SHA } })
	})

	it('runnerPinFromConfig reads a manifest pin', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: MANIFEST.files })).toEqual(MANIFEST)
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA, runner_files: MANIFEST.files }),
		).toEqual(MANIFEST)
	})

	it('runnerPinFromConfig returns null when unset or invalid', () => {
		expect(runnerPinFromConfig({})).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: SHA })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'zz' })).toBeNull()
		// Manifest without box-runner.mjs.
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_files: { 'lib/util.mjs': SHA } }),
		).toBeNull()
		// Unsafe paths.
		for (const bad of [
			'../x.mjs',
			'/etc/passwd',
			'lib/../x.mjs',
			'lib//x.mjs',
			"a'b.mjs",
			'.hidden',
		]) {
			expect(
				runnerPinFromConfig({
					runner_ref: REF,
					runner_files: { 'box-runner.mjs': SHA, [bad]: SHA },
				}),
			).toBeNull()
		}
		// Malformed hash, malformed manifest, manifest disagreeing with runner_sha256.
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_files: { 'box-runner.mjs': 'B'.repeat(64) } }),
		).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: ['box-runner.mjs'] })).toBeNull()
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: 'e'.repeat(64),
				runner_files: MANIFEST.files,
			}),
		).toBeNull()
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

	it('dispatchProvision refuses launch when the runner manifest is invalid', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: REF,
				runner_files: { 'lib/util.mjs': SHA },
			}),
		)
		const out = await dispatchProvision(env, {
			id: 'ca_badmanifest',
			box_id: null,
			queue: 'default',
			route: 'claude',
		} as unknown as CloudAgentRow)
		expect(out).toEqual({ dispatched: false, reason: 'runner_pin_unset' })
	})
})

describe('POST /admin/fleet/pin-runner via pinRunner', () => {
	beforeAll(() => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	afterEach(async () => {
		fetchMock.assertNoPendingInterceptors()
		await env.FERMI_KV.delete('fleet:config')
	})

	it('legacy single-file pin: hashes box-runner.mjs and clears any manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'keep', runner_files: MANIFEST.files }),
		)
		serveDaemon('abc1234', { 'box-runner.mjs': 'runner' })
		const out = await pinRunner(env, { ref: 'abc1234' })
		const sha = await sha256Of('runner')
		expect(out).toMatchObject({ ok: true, status: 200, ref: 'abc1234', sha256: sha })
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(stored).toMatchObject({
			default_env: 'keep',
			runner_ref: 'abc1234',
			runner_sha256: sha,
			runner_files: null,
		})
		expect(runnerPinFromConfig(stored)).toEqual({
			ref: 'abc1234',
			files: { 'box-runner.mjs': sha },
		})
	})

	it('manifest pin: verifies each file against what is served and stores the manifest', async () => {
		const bodies = { 'box-runner.mjs': 'runner', 'harness/claude.mjs': 'h', 'lib/util.mjs': 'u' }
		const files: Record<string, string> = {}
		for (const [p, b] of Object.entries(bodies)) files[p] = await sha256Of(b)
		serveDaemon('abc1234', bodies)
		const out = await pinRunner(env, { ref: 'abc1234', files })
		expect(out).toMatchObject({ ok: true, status: 200, files })
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(runnerPinFromConfig(stored)).toEqual({ ref: 'abc1234', files })
	})

	it('manifest pin by path list: hashes each listed file plus box-runner.mjs', async () => {
		const bodies = { 'box-runner.mjs': 'runner', 'lib/util.mjs': 'u' }
		serveDaemon('abc1234', bodies)
		const out = await pinRunner(env, { ref: 'abc1234', files: ['lib/util.mjs'] })
		expect(out).toMatchObject({
			ok: true,
			files: { 'box-runner.mjs': await sha256Of('runner'), 'lib/util.mjs': await sha256Of('u') },
		})
	})

	it('refuses a manifest whose hash does not match the served file', async () => {
		serveDaemon('abc1234', { 'box-runner.mjs': 'runner' })
		const out = await pinRunner(env, { ref: 'abc1234', files: { 'box-runner.mjs': SHA } })
		expect(out).toMatchObject({ ok: false, status: 409 })
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('400 on a bad ref or malformed files, without fetching', async () => {
		for (const ref of [undefined, '', 'main', 'ABC1234', "abc1234'"]) {
			expect(await pinRunner(env, { ref })).toMatchObject({ ok: false, status: 400 })
		}
		for (const files of [
			'box-runner.mjs',
			42,
			[],
			[1],
			['../evil.mjs'],
			{ 'lib/util.mjs': SHA },
			{ 'box-runner.mjs': 'nothex' },
			{ 'box-runner.mjs': SHA, '/etc/passwd': SHA },
		]) {
			expect(await pinRunner(env, { ref: 'abc1234', files })).toMatchObject({
				ok: false,
				status: 400,
			})
		}
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})
})
