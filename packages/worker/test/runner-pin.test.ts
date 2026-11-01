import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const SHA = 'b'.repeat(64)
const PIN = { ref: 'a'.repeat(40), files: { 'box-runner.mjs': SHA } }

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
})

const H = (c: string) => c.repeat(64)
const MANIFEST = {
	'box-runner.mjs': H('1'),
	'harness/index.mjs': H('2'),
	'lib/util.mjs': H('3'),
}

describe('runner pin manifest (pr-55)', () => {
	beforeAll(setupFleetSchema)

	it('runnerPinFromConfig: legacy single-file pin becomes a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: 'a'.repeat(40), runner_sha256: SHA })).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: 'a'.repeat(40), runner_sha256: SHA, runner_files: null }),
		).toEqual(PIN)
	})

	it('runnerPinFromConfig: reads runner_files as the manifest', () => {
		expect(
			runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: H('1'), runner_files: MANIFEST }),
		).toEqual({ ref: 'v1', files: MANIFEST })
	})

	it('runnerPinFromConfig: null when unset or invalid', () => {
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: 'nothex' })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: "v1'; rm -rf /", runner_sha256: SHA })).toBeNull()
		// manifest without box-runner.mjs
		expect(
			runnerPinFromConfig({ runner_ref: 'v1', runner_files: { 'lib/util.mjs': H('3') } }),
		).toBeNull()
		// unsafe paths
		for (const bad of [
			'../x.mjs',
			'/etc/passwd',
			'lib//x.mjs',
			'lib/./x.mjs',
			'.x',
			"a'b.mjs",
			'-x',
		]) {
			expect(
				runnerPinFromConfig({ runner_ref: 'v1', runner_files: { ...MANIFEST, [bad]: H('4') } }),
			).toBeNull()
		}
		// bad hash in manifest, non-object manifest
		expect(
			runnerPinFromConfig({ runner_ref: 'v1', runner_files: { ...MANIFEST, 'lib/util.mjs': 'x' } }),
		).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: 'v1', runner_files: ['box-runner.mjs'] })).toBeNull()
	})

	it('runnerFetchScript: fetches and verifies every file, installs only after all verify', () => {
		const pin = { ref: 'v1', files: MANIFEST }
		const script = runnerFetchScript(pin)
		for (const [path, sha] of Object.entries(MANIFEST)) {
			expect(script).toContain(runnerUrl('v1', path))
			expect(script).toContain(`echo '${sha}  /opt/fermi/${path}.new' | sha256sum -c -`)
		}
		expect(script).toContain("mkdir -p '/opt/fermi/harness' '/opt/fermi/lib'")
		const lines = script.split('\n')
		const lastVerify = lines.findLastIndex((l) => l.includes('sha256sum -c'))
		const firstMv = lines.findIndex((l) => l.startsWith('mv '))
		expect(firstMv).toBeGreaterThan(lastVerify)
		expect(lines.at(-1)).toBe("mv '/opt/fermi/box-runner.mjs.new' '/opt/fermi/box-runner.mjs'")
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: 'v1', files: { 'lib/util.mjs': H('3') } })).toThrow()
		expect(() => runnerFetchScript({ ref: 'v1', files: { ...MANIFEST, '../x': H('4') } })).toThrow()
		expect(() => runnerFetchScript({ ref: 'bad ref', files: MANIFEST })).toThrow()
	})

	it('runnerUrl defaults to box-runner.mjs and accepts a path', () => {
		expect(runnerUrl('abc')).toBe(
			'https://raw.githubusercontent.com/abel30567/fermi-daemon/abc/box-runner.mjs',
		)
		expect(runnerUrl('abc', 'lib/util.mjs')).toBe(
			'https://raw.githubusercontent.com/abel30567/fermi-daemon/abc/lib/util.mjs',
		)
	})

	it('user-data verifies every manifest file before the box token', () => {
		const script = userData({ runnerPin: { ref: 'v1', files: MANIFEST } })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const sha of Object.values(MANIFEST)) {
			const at = script.indexOf(sha)
			expect(at).toBeGreaterThan(-1)
			expect(at).toBeLessThan(tokenAt)
		}
	})

	it('dispatchProvision refuses launch when the manifest is invalid', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: 'v1',
				runner_sha256: H('1'),
				runner_files: { 'lib/util.mjs': H('3') },
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
})

async function sha256Hex(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('pinRunner (POST /admin/fleet/pin-runner, pr-55)', () => {
	const REF = 'c'.repeat(40)
	const RAW = 'https://raw.githubusercontent.com'
	const BODY: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/index.mjs': 'export const h = 1',
		'lib/util.mjs': 'export const u = 1',
	}
	const serve = (path: string, body = BODY[path], status = 200) =>
		fetchMock
			.get(RAW)
			.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}`, method: 'GET' })
			.reply(status, body)

	beforeAll(() => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	afterEach(() => fetchMock.assertNoPendingInterceptors())

	it('rejects a bad ref and a malformed files map with 400', async () => {
		expect((await pinRunner(env, { ref: 'main' })).status).toBe(400)
		expect((await pinRunner(env, { ref: REF, files: { 'lib/util.mjs': H('3') } })).status).toBe(400)
		expect((await pinRunner(env, { ref: REF, files: { 'box-runner.mjs': 'zz' } })).status).toBe(400)
		expect(
			(await pinRunner(env, { ref: REF, files: { 'box-runner.mjs': H('1'), '../x': H('2') } }))
				.status,
		).toBe(400)
		expect((await pinRunner(env, { ref: REF, files: 'box-runner.mjs' })).status).toBe(400)
	})

	it('legacy single-file pin: fetches box-runner.mjs and stores runner_sha256', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'keep', runner_files: { 'box-runner.mjs': H('9') } }),
		)
		serve('box-runner.mjs')
		const out = await pinRunner(env, { ref: REF })
		const sha = await sha256Hex(BODY['box-runner.mjs'])
		expect(out).toMatchObject({ status: 200, body: { ok: true, ref: REF, sha256: sha } })
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(stored).toMatchObject({
			default_env: 'keep',
			runner_ref: REF,
			runner_sha256: sha,
			runner_files: null,
		})
		expect(runnerPinFromConfig(stored)).toEqual({ ref: REF, files: { 'box-runner.mjs': sha } })
	})

	it('manifest pin: fetches every file, verifies declared hashes, stores the manifest', async () => {
		const files: Record<string, string> = {}
		for (const p of Object.keys(BODY)) {
			files[p] = await sha256Hex(BODY[p])
			serve(p)
		}
		const out = await pinRunner(env, { ref: REF, files })
		expect(out).toMatchObject({ status: 200, body: { ok: true, ref: REF, files } })
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(stored).toMatchObject({
			runner_ref: REF,
			runner_sha256: files['box-runner.mjs'],
			runner_files: files,
		})
		expect(runnerPinFromConfig(stored)).toEqual({ ref: REF, files })
	})

	it('manifest pin refuses when a served file does not match its declared hash', async () => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ runner_ref: 'old' }))
		const files = {
			'box-runner.mjs': await sha256Hex(BODY['box-runner.mjs']),
			'lib/util.mjs': H('3'),
		}
		serve('box-runner.mjs')
		serve('lib/util.mjs')
		const out = await pinRunner(env, { ref: REF, files })
		expect(out).toMatchObject({
			status: 409,
			body: { error: 'sha256_mismatch', path: 'lib/util.mjs' },
		})
		expect(JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}').runner_ref).toBe('old')
	})

	it('manifest pin refuses when a file is missing at the ref', async () => {
		const files = {
			'box-runner.mjs': await sha256Hex(BODY['box-runner.mjs']),
			'lib/gone.mjs': H('3'),
		}
		serve('box-runner.mjs')
		serve('lib/gone.mjs', 'nope', 404)
		const out = await pinRunner(env, { ref: REF, files })
		expect(out).toMatchObject({ status: 502, body: { error: 'fetch_404', path: 'lib/gone.mjs' } })
	})
})
