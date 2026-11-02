import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getFleetConfig, pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const REF = 'a'.repeat(40)
const SHA = 'b'.repeat(64)
const PIN = { ref: REF, files: { 'box-runner.mjs': SHA } }
const MANIFEST = {
	'box-runner.mjs': SHA,
	'harness/claude.mjs': 'c'.repeat(64),
	'lib/util.mjs': 'd'.repeat(64),
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
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

	it('manifest fetch script fetches and verifies every file before installing any', () => {
		const script = runnerFetchScript({ ref: REF, files: MANIFEST })
		const lines = script.split('\n')
		const lastVerify = Math.max(...lines.map((l, i) => (l.includes('sha256sum -c') ? i : -1)))
		const firstInstall = lines.findIndex((l) => l.startsWith('mv '))
		for (const [path, sha] of Object.entries(MANIFEST)) {
			expect(script).toContain(runnerUrl(REF, path))
			expect(script).toContain(`echo '${sha}  /opt/fermi/.runner-staging/${path}'`)
			expect(script).toContain(`mv '/opt/fermi/.runner-staging/${path}' '/opt/fermi/${path}'`)
		}
		expect(lastVerify).toBeGreaterThan(-1)
		expect(firstInstall).toBeGreaterThan(lastVerify)
		const ud = userData({ runnerPin: { ref: REF, files: MANIFEST } })
		expect(ud.indexOf('d'.repeat(64))).toBeLessThan(ud.indexOf('FERMI_BOX_TOKEN='))
	})

	it('fetch script throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/util.mjs': SHA } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': SHA, '../etc/passwd': SHA } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': 'nothex' } })).toThrow()
		expect(() => runnerFetchScript({ ref: "x'; rm -rf /", files: PIN.files })).toThrow()
	})

	it('runnerPinFromConfig: legacy single-file pin, manifest pin, unset and invalid', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA })).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA, runner_files: null }),
		).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA, runner_files: MANIFEST }),
		).toEqual({ ref: REF, files: MANIFEST })
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: MANIFEST })).toEqual({
			ref: REF,
			files: MANIFEST,
		})
		// unset
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_sha256: SHA })).toBeNull()
		// invalid
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'short' })).toBeNull()
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_files: { 'lib/util.mjs': SHA } }),
		).toBeNull()
		for (const bad of ['/etc/x', '../x', 'a/../x', 'a//x', './x', 'a/.', "a'b", 'a b', '']) {
			expect(
				runnerPinFromConfig({
					runner_ref: REF,
					runner_files: { 'box-runner.mjs': SHA, [bad]: SHA },
				}),
			).toBeNull()
		}
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: 'e'.repeat(64),
				runner_files: MANIFEST,
			}),
		).toBeNull()
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_files: ['box-runner.mjs'] as unknown as Record<string, string>,
			}),
		).toBeNull()
	})

	it('dispatchProvision refuses launch when the manifest is invalid', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: REF,
				runner_sha256: SHA,
				runner_files: { 'box-runner.mjs': SHA, '../evil.mjs': SHA },
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

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	const RAW = 'https://raw.githubusercontent.com'
	const BODIES: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/claude.mjs': 'export const h = 1',
		'lib/util.mjs': 'export const u = 2',
	}
	const serve = (path: string, body = BODIES[path], status = 200) =>
		fetchMock
			.get(RAW)
			.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}`, method: 'GET' })
			.reply(status, body)
	const hashes = async () =>
		Object.fromEntries(
			await Promise.all(Object.entries(BODIES).map(async ([p, b]) => [p, await sha256Hex(b)])),
		) as Record<string, string>

	beforeEach(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ default_env: 'keep-me' }))
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	it('legacy {ref} pins box-runner.mjs alone and still yields a bootable pin', async () => {
		serve('box-runner.mjs')
		const sha = await sha256Hex(BODIES['box-runner.mjs'])
		const res = await pinRunner(env, { ref: REF })
		expect(res).toMatchObject({ ok: true, status: 200, ref: REF, sha256: sha })
		const config = await getFleetConfig(env)
		expect(config).toMatchObject({
			default_env: 'keep-me',
			runner_ref: REF,
			runner_sha256: sha,
			runner_files: null,
		})
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files: { 'box-runner.mjs': sha } })
	})

	it('manifest {ref, files} fetches every file, verifies hashes and stores the manifest', async () => {
		for (const p of Object.keys(BODIES)) serve(p)
		const files = await hashes()
		const res = await pinRunner(env, { ref: REF, files })
		expect(res).toMatchObject({ ok: true, status: 200, files, sha256: files['box-runner.mjs'] })
		const config = await getFleetConfig(env)
		expect(config.runner_files).toEqual(files)
		expect(config.runner_sha256).toBe(files['box-runner.mjs'])
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files })
	})

	it('a later legacy pin clears an earlier manifest', async () => {
		for (const p of Object.keys(BODIES)) serve(p)
		await pinRunner(env, { ref: REF, files: await hashes() })
		serve('box-runner.mjs')
		await pinRunner(env, { ref: REF })
		expect((await getFleetConfig(env)).runner_files).toBeNull()
	})

	it('400 on a bad ref or malformed files, without fetching or storing', async () => {
		const files = await hashes()
		for (const body of [
			{},
			{ ref: 'main' },
			{ ref: "abc1234'" },
			{ ref: REF, files: ['box-runner.mjs'] },
			{ ref: REF, files: 'box-runner.mjs' },
			{ ref: REF, files: { 'lib/util.mjs': files['lib/util.mjs'] } },
			{ ref: REF, files: { ...files, '../x.mjs': files['lib/util.mjs'] } },
			{ ref: REF, files: { ...files, 'lib/util.mjs': 'nothex' } },
		]) {
			expect(await pinRunner(env, body)).toMatchObject({ ok: false, status: 400 })
		}
		expect((await getFleetConfig(env)).runner_ref).toBeNull()
	})

	it('refuses a manifest whose hash does not match the fetched file', async () => {
		serve('box-runner.mjs')
		serve('harness/claude.mjs', 'tampered')
		const res = await pinRunner(env, { ref: REF, files: await hashes() })
		expect(res).toMatchObject({ ok: false, status: 409, path: 'harness/claude.mjs' })
		expect((await getFleetConfig(env)).runner_ref).toBeNull()
	})

	it('502 when a manifest file is missing at the ref', async () => {
		serve('box-runner.mjs')
		serve('harness/claude.mjs', 'nope', 404)
		const res = await pinRunner(env, { ref: REF, files: await hashes() })
		expect(res).toMatchObject({ ok: false, status: 502, error: 'fetch_404' })
		expect((await getFleetConfig(env)).runner_ref).toBeNull()
	})
})
