import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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

	it('manifest user-data fetches and verifies every file before the box token', () => {
		const script = userData({ runnerPin: { ref: REF, files: MANIFEST } })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const [path, sha] of Object.entries(MANIFEST)) {
			expect(script).toContain(runnerUrl(REF, path))
			expect(script).toContain(`/opt/fermi/${path}'`)
			const verifyAt = script.indexOf(`echo '${sha}  `)
			expect(verifyAt).toBeGreaterThan(-1)
			expect(verifyAt).toBeLessThan(tokenAt)
		}
		// Every hash is checked before any file is moved into place.
		const lastVerify = script.lastIndexOf('sha256sum -c')
		expect(lastVerify).toBeLessThan(script.indexOf('mv '))
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/util.mjs': SHA } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': SHA, '../x.mjs': SHA } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': 'nothex' } })).toThrow()
		expect(() => runnerFetchScript({ ref: "x'; rm -rf /", files: PIN.files })).toThrow()
	})

	it('user-data has no unpinned curl of main', () => {
		expect(userData()).not.toContain('fermi-daemon/main/')
	})

	it('dispatchProvision refuses launch when the runner manifest is invalid', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: REF,
				runner_sha256: SHA,
				runner_files: { 'box-runner.mjs': SHA, '/etc/passwd': SHA },
			}),
		)
		const agent = { id: 'ca_badpin', box_id: null } as unknown as CloudAgentRow
		const out = await dispatchProvision(env, agent)
		expect(out).toEqual({ dispatched: false, reason: 'runner_pin_invalid' })
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

describe('runnerPinFromConfig', () => {
	it('maps a legacy single-file pin to a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA })).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA, runner_files: null }),
		).toEqual(PIN)
	})

	it('legacy pin yields the same boot fragment as before the manifest', () => {
		const pin = runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA })
		expect(pin).not.toBeNull()
		const script = runnerFetchScript(pin as NonNullable<typeof pin>)
		expect(script).toContain(runnerUrl(REF))
		expect(script).toContain(`echo '${SHA}  `)
		expect(script).toContain("'/opt/fermi/box-runner.mjs'")
		expect(script.match(/curl /g)).toHaveLength(1)
	})

	it('reads a manifest', () => {
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA, runner_files: MANIFEST }),
		).toEqual({ ref: REF, files: MANIFEST })
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: MANIFEST })).toEqual({
			ref: REF,
			files: MANIFEST,
		})
	})

	it('returns null when unset', () => {
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_files: MANIFEST })).toBeNull()
	})

	it('returns null for an invalid manifest', () => {
		const bad = (runner_files: unknown) =>
			runnerPinFromConfig({ runner_ref: REF, runner_files: runner_files as Record<string, string> })
		expect(bad({})).toBeNull()
		expect(bad({ 'lib/util.mjs': SHA })).toBeNull() // no box-runner.mjs
		for (const path of ['../x.mjs', '/abs.mjs', 'lib/../x.mjs', 'lib//x.mjs', '.hidden', "a'b.mjs"])
			expect(bad({ 'box-runner.mjs': SHA, [path]: SHA })).toBeNull()
		expect(bad({ 'box-runner.mjs': 'xyz' })).toBeNull()
		expect(bad(['box-runner.mjs'])).toBeNull()
		// runner_sha256 disagreeing with the manifest's box-runner.mjs is ambiguous -> refuse.
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: 'e'.repeat(64),
				runner_files: MANIFEST,
			}),
		).toBeNull()
	})
})

async function sha256(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('pinRunner', () => {
	const ORIGIN = 'https://raw.githubusercontent.com'
	const FILES = {
		'box-runner.mjs': 'runner',
		'harness/claude.mjs': 'harness',
		'lib/util.mjs': 'util',
	}
	const serve = (ref: string, path: string, body: string, status = 200) =>
		fetchMock
			.get(ORIGIN)
			.intercept({ path: `/abel30567/fermi-daemon/${ref}/${path}` })
			.reply(status, body)

	beforeAll(() => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	afterEach(() => fetchMock.assertNoPendingInterceptors())

	it('rejects a bad ref with 400', async () => {
		for (const ref of [undefined, 'main', 'ABC1234', "abc1234'"]) {
			expect((await pinRunner(env, { ref })).status).toBe(400)
		}
	})

	it('rejects malformed files with 400 without fetching', async () => {
		const ref = 'abc1234'
		for (const files of [
			null,
			[],
			'box-runner.mjs',
			{},
			{ 'lib/util.mjs': SHA },
			{ 'box-runner.mjs': 'nothex' },
			{ 'box-runner.mjs': SHA, '../evil.mjs': SHA },
		]) {
			const out = await pinRunner(env, { ref, files })
			expect(out.status).toBe(400)
			expect(out.body.ok).toBe(false)
		}
	})

	it('legacy single-file pin fetches box-runner.mjs and clears any earlier manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'keep', runner_files: MANIFEST, runner_ref: REF }),
		)
		const ref = 'abc1234'
		serve(ref, 'box-runner.mjs', 'runner')
		const out = await pinRunner(env, { ref })
		const sha = await sha256('runner')
		expect(out).toEqual({ status: 200, body: { ok: true, ref, sha256: sha, bytes: 6 } })
		const config = await getFleetConfig(env)
		expect(config).toMatchObject({
			default_env: 'keep',
			runner_ref: ref,
			runner_sha256: sha,
			runner_files: null,
		})
		expect(runnerPinFromConfig(config)).toEqual({ ref, files: { 'box-runner.mjs': sha } })
	})

	it('manifest pin verifies every served file and stores the manifest', async () => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ default_env: 'keep' }))
		const ref = 'def5678'
		const files: Record<string, string> = {}
		for (const [path, body] of Object.entries(FILES)) {
			files[path] = await sha256(body)
			serve(ref, path, body)
		}
		const out = await pinRunner(env, { ref, files })
		expect(out.status).toBe(200)
		expect(out.body).toMatchObject({ ok: true, ref, sha256: files['box-runner.mjs'], files })
		const config = await getFleetConfig(env)
		expect(config).toMatchObject({
			default_env: 'keep',
			runner_ref: ref,
			runner_sha256: files['box-runner.mjs'],
			runner_files: files,
		})
		expect(runnerPinFromConfig(config)).toEqual({ ref, files })
	})

	it('manifest pin refuses (409) and pins nothing when a served file differs', async () => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ runner_ref: REF, runner_sha256: SHA }))
		const ref = 'fed9876'
		const files: Record<string, string> = {}
		for (const [path, body] of Object.entries(FILES)) files[path] = await sha256(body)
		serve(ref, 'box-runner.mjs', FILES['box-runner.mjs'])
		serve(ref, 'harness/claude.mjs', 'tampered')
		const out = await pinRunner(env, { ref, files })
		expect(out.status).toBe(409)
		expect(out.body).toMatchObject({
			ok: false,
			error: 'sha256_mismatch',
			path: 'harness/claude.mjs',
		})
		expect(await getFleetConfig(env)).toMatchObject({ runner_ref: REF, runner_sha256: SHA })
	})

	it('manifest pin refuses (502) when a file is missing at the ref', async () => {
		const ref = 'fed9877'
		const files = { 'box-runner.mjs': await sha256('runner'), 'lib/util.mjs': await sha256('util') }
		serve(ref, 'box-runner.mjs', 'runner')
		serve(ref, 'lib/util.mjs', 'Not Found', 404)
		const out = await pinRunner(env, { ref, files })
		expect(out).toMatchObject({ status: 502, body: { ok: false, path: 'lib/util.mjs' } })
	})
})
