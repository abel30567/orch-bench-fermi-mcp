import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getFleetConfig, pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const REF = 'a'.repeat(40)
const SHA_RUNNER = 'b'.repeat(64)
const SHA_HARNESS = 'c'.repeat(64)
const SHA_LIB = 'd'.repeat(64)
const PIN = { ref: REF, files: { 'box-runner.mjs': SHA_RUNNER } }
const MANIFEST = {
	ref: REF,
	files: {
		'box-runner.mjs': SHA_RUNNER,
		'harness/claude.mjs': SHA_HARNESS,
		'lib/proof.mjs': SHA_LIB,
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

	it('manifest: fetches every file at the pinned ref into its relative layout', () => {
		const script = runnerFetchScript(MANIFEST)
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(`'${runnerUrl(REF, path)}' -o '/opt/fermi.new/${path}'`)
			expect(script).toContain(`echo '${sha}  /opt/fermi.new/${path}' | sha256sum -c -`)
			expect(script).toContain(`mv '/opt/fermi.new/${path}' '/opt/fermi/${path}'`)
		}
		expect(script).not.toContain('|| true')
	})

	it('manifest: every hash is verified before anything is installed', () => {
		const lines = runnerFetchScript(MANIFEST).split('\n')
		const lastVerify = lines.findLastIndex((l) => l.includes('sha256sum -c'))
		const firstInstall = lines.findIndex((l) => l.startsWith('mv '))
		expect(lastVerify).toBeGreaterThan(-1)
		expect(firstInstall).toBeGreaterThan(lastVerify)
	})

	it('manifest: user-data verifies every file BEFORE materializing the box token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const sha of Object.values(MANIFEST.files)) {
			const at = script.indexOf(sha)
			expect(at).toBeGreaterThan(-1)
			expect(at).toBeLessThan(tokenAt)
		}
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		const bad = (files: Record<string, string>) => () => runnerFetchScript({ ref: REF, files })
		expect(bad({ 'lib/proof.mjs': SHA_LIB })).toThrow() // no box-runner.mjs
		expect(bad({ 'box-runner.mjs': SHA_RUNNER, '../etc/passwd': SHA_LIB })).toThrow()
		expect(bad({ 'box-runner.mjs': SHA_RUNNER, '/abs.mjs': SHA_LIB })).toThrow()
		expect(bad({ 'box-runner.mjs': SHA_RUNNER, "lib/x'; rm -rf /;'": SHA_LIB })).toThrow()
		expect(bad({ 'box-runner.mjs': 'not-a-sha' })).toThrow()
		expect(() => runnerFetchScript({ ref: "x'; id;'", files: PIN.files })).toThrow()
	})

	it('runnerPinFromConfig: legacy single-file pin becomes a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_RUNNER })).toEqual(PIN)
		expect(runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: SHA_RUNNER })).toEqual({
			ref: 'v1',
			files: { 'box-runner.mjs': SHA_RUNNER },
		})
	})

	it('runnerPinFromConfig: reads a multi-file manifest', () => {
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: SHA_RUNNER,
				runner_files: MANIFEST.files,
			}),
		).toEqual(MANIFEST)
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: MANIFEST.files })).toEqual(MANIFEST)
	})

	it('runnerPinFromConfig: null when unset or invalid', () => {
		expect(runnerPinFromConfig({})).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_sha256: SHA_RUNNER })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'zz' })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: 'a b', runner_sha256: SHA_RUNNER })).toBeNull()
		// manifest without box-runner.mjs
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_files: { 'lib/proof.mjs': SHA_LIB } }),
		).toBeNull()
		// unsafe paths
		for (const path of ['../x.mjs', '/x.mjs', 'lib//x.mjs', 'lib/./x.mjs', '.env', 'a b.mjs']) {
			expect(
				runnerPinFromConfig({
					runner_ref: REF,
					runner_files: { 'box-runner.mjs': SHA_RUNNER, [path]: SHA_LIB },
				}),
			).toBeNull()
		}
		// runner_sha256 disagreeing with the manifest is ambiguous: refuse
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: SHA_LIB,
				runner_files: MANIFEST.files,
			}),
		).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: [] })).toBeNull()
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

	it('dispatchProvision refuses launch when the manifest is invalid', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: REF,
				runner_sha256: SHA_RUNNER,
				runner_files: { 'box-runner.mjs': SHA_RUNNER, '../evil.mjs': SHA_LIB },
			}),
		)
		const out = await dispatchProvision(env, { id: 'ca_badpin', box_id: null } as CloudAgentRow)
		expect(out).toEqual({ dispatched: false, reason: 'runner_pin_unset' })
	})
})

const GH = 'https://raw.githubusercontent.com'
const daemonPath = (ref: string, path: string) => `/abel30567/fermi-daemon/${ref}/${path}`
async function sha256(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}
const BODIES: Record<string, string> = {
	'box-runner.mjs': 'console.log("runner")',
	'harness/claude.mjs': 'export const h = 1',
	'lib/proof.mjs': 'export const p = 1',
}
const COMMIT = '0123456789abcdef0123456789abcdef01234567'

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	beforeEach(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ default_env: 'keep-me' }))
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})
	const serve = (paths: string[]) => {
		for (const p of paths)
			fetchMock
				.get(GH)
				.intercept({ path: daemonPath(COMMIT, p) })
				.reply(200, BODIES[p])
	}
	const stored = async () => JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')

	it('legacy single-file pin still works and still boots', async () => {
		serve(['box-runner.mjs'])
		const res = await pinRunner(env, { ref: COMMIT })
		expect(res.status).toBe(200)
		const want = await sha256(BODIES['box-runner.mjs'])
		expect(await res.json()).toMatchObject({ ok: true, ref: COMMIT, sha256: want })
		const cfg = await stored()
		expect(cfg).toMatchObject({ default_env: 'keep-me', runner_ref: COMMIT, runner_sha256: want })
		expect(cfg.runner_files).toBeUndefined()
		const pin = runnerPinFromConfig(await getFleetConfig(env))
		expect(pin).toEqual({ ref: COMMIT, files: { 'box-runner.mjs': want } })
		expect(runnerFetchScript(pin as NonNullable<typeof pin>)).toContain(want)
	})

	it('pins a manifest of paths (box-runner.mjs always included)', async () => {
		serve(Object.keys(BODIES))
		const res = await pinRunner(env, {
			ref: COMMIT,
			files: ['harness/claude.mjs', 'lib/proof.mjs'],
		})
		expect(res.status).toBe(200)
		const files: Record<string, string> = {}
		for (const [p, body] of Object.entries(BODIES)) files[p] = await sha256(body)
		const cfg = await stored()
		expect(cfg).toMatchObject({
			default_env: 'keep-me',
			runner_ref: COMMIT,
			runner_sha256: files['box-runner.mjs'],
			runner_files: files,
		})
		expect(runnerPinFromConfig(await getFleetConfig(env))).toEqual({ ref: COMMIT, files })
	})

	it('accepts a {path: sha256} manifest and refuses a hash mismatch', async () => {
		const files: Record<string, string> = {}
		for (const [p, body] of Object.entries(BODIES)) files[p] = await sha256(body)
		serve(Object.keys(BODIES))
		const ok = await pinRunner(env, { ref: COMMIT, files })
		expect(ok.status).toBe(200)
		expect((await stored()).runner_files).toEqual(files)

		serve(['box-runner.mjs', 'harness/claude.mjs'])
		const bad = await pinRunner(env, {
			ref: COMMIT,
			files: { ...files, 'harness/claude.mjs': 'e'.repeat(64) },
		})
		expect(bad.status).toBe(409)
		expect(await bad.json()).toMatchObject({ ok: false, path: 'harness/claude.mjs' })
		expect((await stored()).runner_files).toEqual(files) // unchanged
	})

	it('a later legacy pin clears a previous manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ runner_ref: REF, runner_sha256: SHA_RUNNER, runner_files: MANIFEST.files }),
		)
		serve(['box-runner.mjs'])
		expect((await pinRunner(env, { ref: COMMIT })).status).toBe(200)
		expect((await stored()).runner_files).toBeUndefined()
	})

	it('400 on a bad ref', async () => {
		for (const ref of [undefined, '', 'main', 'v1', "abc1234'"]) {
			const res = await pinRunner(env, { ref })
			expect(res.status).toBe(400)
		}
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})

	it('400 on malformed files', async () => {
		for (const files of [
			'box-runner.mjs',
			42,
			['../etc/passwd'],
			['/abs.mjs'],
			[7],
			{ 'lib/x.mjs': 'nope' },
			{ '../x.mjs': SHA_LIB },
			['lib', 'lib/x.mjs'],
			Array.from({ length: 100 }, (_, i) => `lib/f${i}.mjs`),
		]) {
			const res = await pinRunner(env, { ref: COMMIT, files })
			expect(res.status).toBe(400)
		}
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})

	it('502 and no pin when a manifest file is missing upstream', async () => {
		serve(['box-runner.mjs'])
		fetchMock
			.get(GH)
			.intercept({ path: daemonPath(COMMIT, 'harness/claude.mjs') })
			.reply(404, 'nope')
		const res = await pinRunner(env, { ref: COMMIT, files: ['harness/claude.mjs'] })
		expect(res.status).toBe(502)
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})
})
