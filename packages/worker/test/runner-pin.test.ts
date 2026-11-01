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

function agentRow(id: string): CloudAgentRow {
	return {
		id,
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
		const out = await dispatchProvision(env, agentRow('ca_pinless'))
		expect(out.dispatched).toBe(false)
		expect(out.reason).toBe('runner_pin_unset')
	})

	it('dispatchProvision refuses launch when the manifest is invalid', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: 'a'.repeat(40),
				runner_sha256: SHA,
				runner_files: { '../evil.mjs': SHA, 'box-runner.mjs': SHA },
			}),
		)
		const out = await dispatchProvision(env, agentRow('ca_badpin'))
		expect(out.reason).toBe('runner_pin_unset')
	})

	it('dispatchProvision accepts a legacy single-file pin (passes the pin gate)', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: null, runner_ref: 'a'.repeat(40), runner_sha256: SHA }),
		)
		const out = await dispatchProvision(env, agentRow('ca_legacy'))
		expect(out.reason).toBe('no_environment_configured')
	})
})

describe('runner pin manifest', () => {
	it('legacy config (runner_sha256 only) maps to a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: PIN.ref, runner_sha256: SHA })).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: PIN.ref, runner_sha256: SHA, runner_files: null }),
		).toEqual(PIN)
	})

	it('runner_files wins over runner_sha256', () => {
		expect(
			runnerPinFromConfig({
				runner_ref: MANIFEST.ref,
				runner_sha256: SHA,
				runner_files: MANIFEST.files,
			}),
		).toEqual(MANIFEST)
	})

	it('returns null when unset or invalid', () => {
		const ref = MANIFEST.ref
		const bad: Array<Record<string, unknown>> = [
			{},
			{ runner_ref: null, runner_sha256: SHA },
			{ runner_ref: ref, runner_sha256: null },
			{ runner_ref: ref, runner_sha256: 'xyz' },
			{ runner_ref: "a'; rm -rf /", runner_sha256: SHA },
			{ runner_ref: '../main', runner_sha256: SHA },
			{ runner_ref: ref, runner_files: {} },
			{ runner_ref: ref, runner_files: ['box-runner.mjs'] },
			{ runner_ref: ref, runner_files: { 'lib/util.mjs': SHA } }, // no box-runner.mjs
			{ runner_ref: ref, runner_files: { 'box-runner.mjs': 'nothex' } },
			...['../x.mjs', '/etc/passwd', 'lib/../../x', 'lib//x', './x', 'a b', "x'.mjs", '.env'].map(
				(p) => ({ runner_ref: ref, runner_files: { 'box-runner.mjs': SHA, [p]: SHA } }),
			),
		]
		for (const config of bad) expect(runnerPinFromConfig(config), JSON.stringify(config)).toBeNull()
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: PIN.ref, files: { 'lib/x.mjs': SHA } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: PIN.ref, files: { 'box-runner.mjs': SHA, '../x': SHA } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: "x'y", files: PIN.files })).toThrow()
	})

	it('fetch script fetches and verifies every file before installing any', () => {
		const script = runnerFetchScript(MANIFEST)
		const firstInstall = script.indexOf('mv -f')
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(runnerUrl(MANIFEST.ref, path))
			expect(script).toContain(`${sha}  ${path}`)
			expect(script.indexOf(runnerUrl(MANIFEST.ref, path))).toBeLessThan(firstInstall)
			expect(script).toContain(`/opt/fermi/${path}'`)
		}
		expect(script.indexOf('sha256sum -c')).toBeLessThan(firstInstall)
	})

	it('user-data verifies every manifest file before the box token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const sha of Object.values(MANIFEST.files)) {
			expect(script.indexOf(sha)).toBeGreaterThan(-1)
			expect(script.indexOf(sha)).toBeLessThan(tokenAt)
		}
	})

	it('runnerUrl defaults to box-runner.mjs', () => {
		expect(runnerUrl('abc')).toBe(
			'https://raw.githubusercontent.com/abel30567/fermi-daemon/abc/box-runner.mjs',
		)
		expect(runnerUrl('abc', 'lib/x.mjs')).toBe(
			'https://raw.githubusercontent.com/abel30567/fermi-daemon/abc/lib/x.mjs',
		)
	})
})

async function sha256(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	const REF = 'c'.repeat(40)
	const BODIES: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/claude.mjs': 'export const h = 1',
		'lib/util.mjs': 'export const u = 1',
	}
	const serve = (path: string, status = 200) =>
		fetchMock
			.get('https://raw.githubusercontent.com')
			.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}` })
			.reply(status, BODIES[path] ?? '')

	beforeEach(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ default_env: 'keep-me' }))
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	it('legacy single-file pin hashes box-runner.mjs and clears any manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'keep-me', runner_files: { 'box-runner.mjs': SHA } }),
		)
		serve('box-runner.mjs')
		const out = await pinRunner(env, { ref: REF })
		const want = await sha256(BODIES['box-runner.mjs'])
		expect(out.status).toBe(200)
		expect(out.body).toMatchObject({ ok: true, ref: REF, sha256: want })
		const config = await getFleetConfig(env)
		expect(config).toMatchObject({
			default_env: 'keep-me',
			runner_ref: REF,
			runner_sha256: want,
			runner_files: null,
		})
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files: { 'box-runner.mjs': want } })
	})

	it('pins a manifest given as a path list (box-runner.mjs always included)', async () => {
		for (const p of Object.keys(BODIES)) serve(p)
		const out = await pinRunner(env, { ref: REF, files: ['harness/claude.mjs', 'lib/util.mjs'] })
		expect(out.status).toBe(200)
		const files: Record<string, string> = {}
		for (const [p, b] of Object.entries(BODIES)) files[p] = await sha256(b)
		const config = await getFleetConfig(env)
		expect(config.runner_files).toEqual(files)
		expect(config.runner_sha256).toBe(files['box-runner.mjs'])
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files })
	})

	it('pins a {path: sha256} manifest when the served hashes match', async () => {
		for (const p of Object.keys(BODIES)) serve(p)
		const files: Record<string, string> = {}
		for (const [p, b] of Object.entries(BODIES)) files[p] = await sha256(b)
		const out = await pinRunner(env, { ref: REF, files })
		expect(out.status).toBe(200)
		expect((await getFleetConfig(env)).runner_files).toEqual(files)
	})

	it('refuses a {path: sha256} manifest whose hash does not match, storing nothing', async () => {
		serve('box-runner.mjs')
		serve('lib/util.mjs')
		const out = await pinRunner(env, {
			ref: REF,
			files: { 'box-runner.mjs': await sha256(BODIES['box-runner.mjs']), 'lib/util.mjs': SHA },
		})
		expect(out.status).toBe(409)
		expect(out.body).toMatchObject({ ok: false, error: 'sha256_mismatch', path: 'lib/util.mjs' })
		expect((await getFleetConfig(env)).runner_ref).toBeNull()
	})

	it('refuses when a manifest file is missing at the ref', async () => {
		serve('box-runner.mjs')
		serve('lib/util.mjs', 404)
		const out = await pinRunner(env, { ref: REF, files: ['lib/util.mjs'] })
		expect(out.status).toBe(502)
		expect((await getFleetConfig(env)).runner_ref).toBeNull()
	})

	it('400 on a bad ref or malformed files', async () => {
		const bad: Array<{ ref?: unknown; files?: unknown }> = [
			{},
			{ ref: 'main' },
			{ ref: 'abc' },
			{ ref: REF, files: null },
			{ ref: REF, files: 'box-runner.mjs' },
			{ ref: REF, files: [] },
			{ ref: REF, files: {} },
			{ ref: REF, files: ['../etc/passwd'] },
			{ ref: REF, files: [42] },
			{ ref: REF, files: { '/abs.mjs': SHA } },
			{ ref: REF, files: { 'lib/x.mjs': 'nothex' } },
		]
		for (const body of bad) {
			const out = await pinRunner(env, body)
			expect(out.status, JSON.stringify(body)).toBe(400)
			expect(out.body.ok).toBe(false)
		}
		expect((await getFleetConfig(env)).runner_ref).toBeNull()
	})
})
