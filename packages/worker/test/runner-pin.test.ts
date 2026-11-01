import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const REF = 'a'.repeat(40)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)
const SHA_D = 'd'.repeat(64)
const PIN = { ref: REF, files: { 'box-runner.mjs': SHA_B } }
const MANIFEST = {
	ref: REF,
	files: { 'box-runner.mjs': SHA_B, 'harness/claude.mjs': SHA_C, 'lib/report.mjs': SHA_D },
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
		expect(script).toContain(SHA_B)
		expect(script).not.toContain('/main/') // no floating branch
		expect(script).not.toContain('|| true') // fail closed, no baked-copy fallback
	})

	it('user-data verifies the runner BEFORE materializing the box token', () => {
		const script = userData()
		const verifyAt = script.indexOf(SHA_B)
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

	it('dispatchProvision refuses launch on a manifest without box-runner.mjs', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: REF,
				runner_sha256: SHA_B,
				runner_files: { 'lib/report.mjs': SHA_D },
			}),
		)
		const out = await dispatchProvision(env, agentRow('ca_badmanifest'))
		expect(out.reason).toBe('runner_pin_unset')
	})

	it('a legacy single-file pin passes the pin gate and boots box-runner.mjs alone', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ runner_ref: REF, runner_sha256: SHA_B }),
		)
		const out = await dispatchProvision(env, agentRow('ca_legacy'))
		expect(out.reason).toBe('no_environment_configured')
		const pin = runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_B })
		expect(pin).toEqual(PIN)
		const script = userData({ runnerPin: pin ?? undefined })
		expect(script).toContain(runnerUrl(REF))
		expect(script).toContain(`${SHA_B}  box-runner.mjs`)
		expect(script).toContain("'/opt/fermi/box-runner.mjs'")
	})
})

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

describe('runner pin manifest (DMN-8 prerequisite)', () => {
	it('runnerPinFromConfig reads a manifest, legacy pin, or nothing', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: MANIFEST.files })).toEqual(MANIFEST)
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_B, runner_files: null }),
		).toEqual(PIN)
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: SHA_B })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'nothex' })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: "x'; rm -rf /", runner_sha256: SHA_B })).toBeNull()
	})

	it('runnerPinFromConfig rejects a manifest without box-runner.mjs or with an unsafe path', () => {
		const withFiles = (files: unknown) =>
			runnerPinFromConfig({ runner_ref: REF, runner_files: files })
		expect(withFiles({ 'lib/report.mjs': SHA_D })).toBeNull()
		expect(withFiles({})).toBeNull()
		expect(withFiles(['box-runner.mjs'])).toBeNull()
		expect(withFiles({ 'box-runner.mjs': 'short' })).toBeNull()
		for (const bad of [
			'../x.mjs',
			'/etc/passwd',
			'lib/../../x',
			'lib//x',
			'./x',
			"a'b",
			'a b',
			'lib/',
		]) {
			expect(withFiles({ 'box-runner.mjs': SHA_B, [bad]: SHA_C }), bad).toBeNull()
		}
	})

	it('runnerFetchScript fetches every file at the ref and verifies all hashes before installing', () => {
		const script = runnerFetchScript(MANIFEST)
		const lines = script.split('\n')
		const verifyAt = lines.findIndex((l) => l.includes('sha256sum -c'))
		const firstMv = lines.findIndex((l) => l.startsWith('mv '))
		expect(verifyAt).toBeGreaterThan(-1)
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			const curlAt = lines.findIndex((l) => l.includes(runnerUrl(REF, path)))
			expect(curlAt, path).toBeGreaterThan(-1)
			expect(curlAt).toBeLessThan(verifyAt)
			expect(lines[verifyAt]).toContain(`${sha}  ${path}`)
			expect(
				lines.findIndex((l) => l.includes(`/opt/fermi/${path}'`) && l.startsWith('mv ')),
			).toBeGreaterThan(verifyAt)
		}
		expect(firstMv).toBeGreaterThan(verifyAt)
		expect(script).not.toContain('|| true')
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/report.mjs': SHA_D } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': SHA_B, '../x': SHA_C } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': 'nope' } })).toThrow()
		expect(() => runnerFetchScript({ ref: "a'b", files: PIN.files })).toThrow()
	})

	it('runnerUrl defaults to box-runner.mjs and accepts a path', () => {
		expect(runnerUrl(REF)).toBe(
			`https://raw.githubusercontent.com/abel30567/fermi-daemon/${REF}/box-runner.mjs`,
		)
		expect(runnerUrl(REF, 'lib/report.mjs')).toBe(
			`https://raw.githubusercontent.com/abel30567/fermi-daemon/${REF}/lib/report.mjs`,
		)
	})
})

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	const RAW = 'https://raw.githubusercontent.com'
	const BODIES: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/claude.mjs': 'export const route = "claude"',
		'lib/report.mjs': 'export function report() {}',
	}
	const serve = (path: string, body = BODIES[path], status = 200) =>
		fetchMock
			.get(RAW)
			.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}`, method: 'GET' })
			.reply(status, body)
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

	it('legacy body { ref } pins box-runner.mjs alone', async () => {
		serve('box-runner.mjs')
		const res = await pinRunner(env, { ref: REF })
		const sha = await sha256Hex(BODIES['box-runner.mjs'])
		expect(res).toMatchObject({ status: 200, body: { ok: true, ref: REF, sha256: sha } })
		expect(await stored()).toMatchObject({
			default_env: 'keep-me',
			runner_ref: REF,
			runner_sha256: sha,
			runner_files: { 'box-runner.mjs': sha },
		})
		expect(runnerPinFromConfig(await stored())).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': sha },
		})
	})

	it('a path list fetches and hashes every file, always including box-runner.mjs', async () => {
		for (const p of Object.keys(BODIES)) serve(p)
		const res = await pinRunner(env, { ref: REF, files: ['harness/claude.mjs', 'lib/report.mjs'] })
		expect(res.status).toBe(200)
		const files: Record<string, string> = {}
		for (const [p, b] of Object.entries(BODIES)) files[p] = await sha256Hex(b)
		expect((await stored()).runner_files).toEqual(files)
		expect(runnerPinFromConfig(await stored())).toEqual({ ref: REF, files })
	})

	it('a { path: sha256 } manifest is accepted when the served hashes match', async () => {
		for (const p of Object.keys(BODIES)) serve(p)
		const files: Record<string, string> = {}
		for (const [p, b] of Object.entries(BODIES)) files[p] = await sha256Hex(b)
		const res = await pinRunner(env, { ref: REF, files })
		expect(res).toMatchObject({ status: 200, body: { ok: true, files } })
	})

	it('a manifest hash that does not match what the ref serves is refused, pin untouched', async () => {
		serve('box-runner.mjs')
		serve('lib/report.mjs')
		const res = await pinRunner(env, {
			ref: REF,
			files: {
				'box-runner.mjs': await sha256Hex(BODIES['box-runner.mjs']),
				'lib/report.mjs': SHA_D,
			},
		})
		expect(res).toMatchObject({ status: 409, body: { ok: false, path: 'lib/report.mjs' } })
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})

	it('a file missing at the ref fails with 502, pin untouched', async () => {
		serve('box-runner.mjs')
		serve('lib/report.mjs', 'nope', 404)
		const res = await pinRunner(env, { ref: REF, files: ['lib/report.mjs'] })
		expect(res).toMatchObject({ status: 502, body: { ok: false, path: 'lib/report.mjs' } })
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})

	it('returns 400 on a bad ref or malformed files, without fetching', async () => {
		for (const ref of [undefined, '', 'main', 'v1', 'A'.repeat(40), `${REF}/x`]) {
			expect((await pinRunner(env, { ref })).status, String(ref)).toBe(400)
		}
		for (const files of [
			'box-runner.mjs',
			42,
			true,
			[],
			{},
			[1],
			['../etc/passwd'],
			['/abs.mjs'],
			{ 'lib/x.mjs': 'nothex' },
			{ '../x': SHA_C },
		]) {
			expect((await pinRunner(env, { ref: REF, files })).status, JSON.stringify(files)).toBe(400)
		}
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})
})
