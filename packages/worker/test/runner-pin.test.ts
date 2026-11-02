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
	ref: REF,
	files: {
		'box-runner.mjs': SHA,
		'harness/claude.mjs': 'c'.repeat(64),
		'lib/util.mjs': 'd'.repeat(64),
	},
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

	it('legacy single-file config pins box-runner.mjs alone', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA })).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA, runner_files: null }),
		).toEqual(PIN)
		const script = runnerFetchScript(PIN)
		expect(script).toContain(`${runnerUrl(REF)}' -o '/opt/fermi/.runner-stage/box-runner.mjs'`)
		expect(script).toContain(
			"mv '/opt/fermi/.runner-stage/box-runner.mjs' '/opt/fermi/box-runner.mjs'",
		)
	})

	it('manifest config: fetches, verifies and installs every file in the same layout', () => {
		const pin = runnerPinFromConfig({
			runner_ref: REF,
			runner_sha256: SHA,
			runner_files: MANIFEST.files,
		})
		expect(pin).toEqual(MANIFEST)
		const script = runnerFetchScript(MANIFEST)
		const lines = script.split('\n')
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(`'${runnerUrl(REF, path)}' -o '/opt/fermi/.runner-stage/${path}'`)
			expect(script).toContain(`echo '${sha}  /opt/fermi/.runner-stage/${path}' | sha256sum -c -`)
			expect(script).toContain(`mv '/opt/fermi/.runner-stage/${path}' '/opt/fermi/${path}'`)
		}
		// Every hash is checked before ANY file is installed.
		const lastVerify = Math.max(...lines.flatMap((l, i) => (l.includes('sha256sum') ? [i] : [])))
		const firstMv = lines.findIndex((l) => l.startsWith('mv '))
		expect(lastVerify).toBeLessThan(firstMv)
	})

	it('user-data verifies every manifest file BEFORE materializing the box token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const sha of Object.values(MANIFEST.files)) {
			const at = script.indexOf(sha)
			expect(at).toBeGreaterThan(-1)
			expect(at).toBeLessThan(tokenAt)
		}
	})

	it('runnerPinFromConfig returns null when unset or invalid', () => {
		const files = MANIFEST.files
		for (const cfg of [
			{},
			{ runner_ref: null, runner_sha256: null },
			{ runner_ref: REF, runner_sha256: null },
			{ runner_ref: REF, runner_sha256: 'nothex' },
			{ runner_ref: "a'; rm -rf /; '", runner_sha256: SHA },
			{ runner_ref: '../evil', runner_sha256: SHA },
			// manifest without box-runner.mjs
			{ runner_ref: REF, runner_sha256: SHA, runner_files: { 'lib/util.mjs': SHA } },
			// unsafe paths
			{ runner_ref: REF, runner_files: { ...files, '../etc/passwd': SHA } },
			{ runner_ref: REF, runner_files: { ...files, '/etc/passwd': SHA } },
			{ runner_ref: REF, runner_files: { ...files, 'lib/./x.mjs': SHA } },
			{ runner_ref: REF, runner_files: { ...files, 'lib//x.mjs': SHA } },
			{ runner_ref: REF, runner_files: { ...files, "x'.mjs": SHA } },
			{ runner_ref: REF, runner_files: { ...files, 'lib/x.mjs': 'short' } },
			{ runner_ref: REF, runner_files: [] },
			{ runner_ref: REF, runner_files: {} },
			{ runner_ref: REF, runner_files: 'box-runner.mjs' },
		]) {
			expect(runnerPinFromConfig(cfg), JSON.stringify(cfg)).toBeNull()
		}
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/util.mjs': SHA } })).toThrow()
		expect(() => runnerFetchScript({ ref: REF, files: { ...PIN.files, '../x': SHA } })).toThrow()
		expect(() => runnerFetchScript({ ref: REF, files: {} })).toThrow()
		expect(() => runnerFetchScript({ ref: "x'y", files: PIN.files })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': 'z'.repeat(64) } }),
		).toThrow()
	})

	it('dispatchProvision refuses launch when the runner manifest is invalid', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: REF,
				runner_sha256: SHA,
				runner_files: { 'lib/util.mjs': SHA },
			}),
		)
		const out = await dispatchProvision(env, {
			id: 'ca_badpin',
			status: 'launching',
			route: 'claude',
			queue: 'default',
			box_id: null,
			ttl_seconds: 3600,
			created_at: Date.now(),
		} as unknown as CloudAgentRow)
		expect(out).toMatchObject({ dispatched: false, reason: 'runner_pin_invalid' })
	})
})

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	const ORIGIN = 'https://raw.githubusercontent.com'
	const BODIES: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")\n',
		'harness/claude.mjs': 'export const h = 1\n',
		'lib/util.mjs': 'export const u = 1\n',
	}
	const serve = (path: string, status = 200) =>
		fetchMock
			.get(ORIGIN)
			.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}`, method: 'GET' })
			.reply(status, status === 200 ? BODIES[path] : 'nope')
	const stored = async () => JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')

	beforeEach(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ region: 'eu-west-1' }))
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	it('legacy single-file pin still works and yields a bootable pin', async () => {
		serve('box-runner.mjs')
		const out = await pinRunner(env, { ref: REF })
		const sha = await sha256Hex(BODIES['box-runner.mjs'])
		expect(out.status).toBe(200)
		expect(out.body).toMatchObject({ ok: true, ref: REF, sha256: sha })
		expect(await stored()).toMatchObject({
			region: 'eu-west-1',
			runner_ref: REF,
			runner_sha256: sha,
			runner_files: null,
		})
		expect(runnerPinFromConfig(await getFleetConfig(env))).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': sha },
		})
	})

	it('a list of paths is fetched, hashed and stored as the manifest', async () => {
		for (const p of Object.keys(BODIES)) serve(p)
		const out = await pinRunner(env, { ref: REF, files: Object.keys(BODIES) })
		const files: Record<string, string> = {}
		for (const [p, body] of Object.entries(BODIES)) files[p] = await sha256Hex(body)
		expect(out).toMatchObject({ status: 200, body: { ok: true, ref: REF, files } })
		expect(await stored()).toMatchObject({
			runner_ref: REF,
			runner_sha256: files['box-runner.mjs'],
			runner_files: files,
		})
		expect(runnerPinFromConfig(await getFleetConfig(env))).toEqual({ ref: REF, files })
	})

	it('a { path: sha256 } manifest is verified against the fetched files', async () => {
		const files: Record<string, string> = {}
		for (const [p, body] of Object.entries(BODIES)) files[p] = await sha256Hex(body)
		for (const p of Object.keys(BODIES)) serve(p)
		const ok = await pinRunner(env, { ref: REF, files })
		expect(ok).toMatchObject({ status: 200, body: { ok: true, files } })

		await env.FERMI_KV.put('fleet:config', '{}')
		serve('box-runner.mjs')
		serve('harness/claude.mjs')
		const bad = await pinRunner(env, {
			ref: REF,
			files: {
				...files,
				'harness/claude.mjs': 'e'.repeat(64),
				'lib/util.mjs': files['lib/util.mjs'],
			},
		})
		expect(bad).toMatchObject({
			status: 409,
			body: { ok: false, error: 'sha256_mismatch', path: 'harness/claude.mjs' },
		})
		expect(await stored()).toEqual({}) // nothing pinned on mismatch
	})

	it('400 on a bad ref or malformed files, without fetching anything', async () => {
		for (const body of [
			{},
			{ ref: 'main' },
			{ ref: "abc1234'" },
			{ ref: REF, files: 'box-runner.mjs' },
			{ ref: REF, files: 42 },
			{ ref: REF, files: null },
			{ ref: REF, files: [] },
			{ ref: REF, files: ['lib/util.mjs'] },
			{ ref: REF, files: ['box-runner.mjs', '../secrets'] },
			{ ref: REF, files: ['box-runner.mjs', '/etc/passwd'] },
			{ ref: REF, files: ['box-runner.mjs', 'box-runner.mjs'] },
			{ ref: REF, files: ['box-runner.mjs', 7] },
			{ ref: REF, files: { 'box-runner.mjs': 'nothex' } },
			{ ref: REF, files: { 'lib/util.mjs': SHA } },
		]) {
			const out = await pinRunner(env, body as { ref: string })
			expect(out.status, JSON.stringify(body)).toBe(400)
			expect(out.body.ok).toBe(false)
		}
		expect(await stored()).toEqual({ region: 'eu-west-1' })
	})

	it('502 and nothing pinned when a manifest file is missing upstream', async () => {
		serve('box-runner.mjs')
		serve('lib/util.mjs', 404)
		const out = await pinRunner(env, { ref: REF, files: ['box-runner.mjs', 'lib/util.mjs'] })
		expect(out).toMatchObject({
			status: 502,
			body: { ok: false, error: 'fetch_404', path: 'lib/util.mjs' },
		})
		expect(await stored()).toEqual({ region: 'eu-west-1' })
	})
})
