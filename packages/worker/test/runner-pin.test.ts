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
		'box-runner.mjs': 'b'.repeat(64),
		'harness/claude.mjs': 'c'.repeat(64),
		'lib/util.mjs': 'd'.repeat(64),
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

	it('user-data fetches and verifies EVERY manifest file before the box token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(runnerUrl(REF, path))
			expect(script).toContain(`/opt/fermi/${path}.new`)
			const verifyAt = script.indexOf(`echo '${sha}  /opt/fermi/${path}.new' | sha256sum -c -`)
			expect(verifyAt).toBeGreaterThan(-1)
			expect(verifyAt).toBeLessThan(tokenAt)
		}
		expect(script).toContain("mkdir -p '/opt/fermi/harness'")
		expect(script).toContain("mkdir -p '/opt/fermi/lib'")
		// Nothing is installed until every hash checked out.
		const lastVerify = script.lastIndexOf('sha256sum -c -')
		const firstInstall = script.indexOf("mv '/opt/fermi/")
		expect(firstInstall).toBeGreaterThan(lastVerify)
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		const h = 'e'.repeat(64)
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/x.mjs': h } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': h, '../x.mjs': h } }),
		).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': h, "a'b.mjs": h } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': 'nope' } })).toThrow()
		expect(() => runnerFetchScript({ ref: "x';rm", files: { 'box-runner.mjs': h } })).toThrow()
		expect(() => runnerFetchScript({ ref: REF, files: {} })).toThrow()
	})

	it('runnerPinFromConfig reads legacy pins, manifests, and rejects invalid ones', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA })).toEqual(PIN)
		expect(runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: SHA })).toEqual({
			ref: 'v1',
			files: { 'box-runner.mjs': SHA },
		})
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA, runner_files: MANIFEST.files }),
		).toEqual(MANIFEST)
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA, runner_files: null }),
		).toEqual(PIN)
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_files: MANIFEST.files })).toBeNull()
		// Manifest without box-runner.mjs, or with an unsafe path, is invalid (no fallback).
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: SHA,
				runner_files: { 'lib/util.mjs': SHA },
			}),
		).toBeNull()
		for (const bad of ['../evil.mjs', '/etc/passwd', 'lib//x.mjs', 'lib/./x.mjs', 'a b.mjs']) {
			expect(
				runnerPinFromConfig({
					runner_ref: REF,
					runner_files: { 'box-runner.mjs': SHA, [bad]: SHA },
				}),
			).toBeNull()
		}
	})

	it('dispatchProvision boots past the pin gate with a legacy single-file pin', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'test-env', runner_ref: REF, runner_sha256: SHA }),
		)
		const out = await dispatchProvision(env, agentRow('ca_legacy'))
		expect(out.reason).not.toBe('runner_pin_unset')
	})

	it('dispatchProvision refuses launch on an invalid manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: REF,
				runner_sha256: SHA,
				runner_files: { 'box-runner.mjs': SHA, '../x': SHA },
			}),
		)
		const out = await dispatchProvision(env, agentRow('ca_badmanifest'))
		expect(out).toEqual({ dispatched: false, reason: 'runner_pin_unset' })
	})

	it('dispatchProvision refuses launch when the runner pin is unset', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'test-env', runner_ref: null, runner_sha256: null }),
		)
		const agent = agentRow('ca_pinless')
		const out = await dispatchProvision(env, agent)
		expect(out.dispatched).toBe(false)
		expect(out.reason).toBe('runner_pin_unset')
	})
})

describe('POST /admin/fleet/pin-runner manifest (pinRunner)', () => {
	const ref = '1234567'
	const base = 'https://raw.githubusercontent.com'
	const sha256 = async (text: string) => {
		const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
		return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
	}
	const serve = (path: string, body: string) =>
		fetchMock
			.get(base)
			.intercept({ path: `/abel30567/fermi-daemon/${ref}/${path}` })
			.reply(200, body)

	beforeAll(() => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	afterEach(() => fetchMock.assertNoPendingInterceptors())

	it('rejects a bad ref or malformed files with 400', async () => {
		expect((await pinRunner(env, { ref: 'main' })).status).toBe(400)
		expect((await pinRunner(env, { ref, files: 'box-runner.mjs' })).status).toBe(400)
		expect((await pinRunner(env, { ref, files: ['../x.mjs'] })).status).toBe(400)
		expect((await pinRunner(env, { ref, files: { 'lib/a.mjs': SHA } })).status).toBe(400)
		expect((await pinRunner(env, { ref, files: { 'box-runner.mjs': 'x' } })).status).toBe(400)
		expect((await pinRunner(env, { ref, files: null })).status).toBe(400)
	})

	it('legacy single-file pin still works and clears any earlier manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'x', runner_files: MANIFEST.files }),
		)
		serve('box-runner.mjs', 'runner')
		const res = await pinRunner(env, { ref })
		expect(res).toMatchObject({
			status: 200,
			body: { ok: true, ref, sha256: await sha256('runner') },
		})
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(stored).toMatchObject({ default_env: 'x', runner_ref: ref, runner_files: null })
		expect(runnerPinFromConfig(stored)).toEqual({
			ref,
			files: { 'box-runner.mjs': await sha256('runner') },
		})
	})

	it('pins a list of paths, always including box-runner.mjs', async () => {
		serve('box-runner.mjs', 'runner')
		serve('harness/claude.mjs', 'claude')
		const res = await pinRunner(env, { ref, files: ['harness/claude.mjs'] })
		const files = {
			'box-runner.mjs': await sha256('runner'),
			'harness/claude.mjs': await sha256('claude'),
		}
		expect(res).toMatchObject({ status: 200, body: { ok: true, files } })
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(runnerPinFromConfig(stored)).toEqual({ ref, files })
	})

	it('accepts a {path: sha256} manifest that matches what is served', async () => {
		const files = {
			'box-runner.mjs': await sha256('runner'),
			'lib/util.mjs': await sha256('util'),
		}
		serve('box-runner.mjs', 'runner')
		serve('lib/util.mjs', 'util')
		expect(await pinRunner(env, { ref, files })).toMatchObject({ status: 200 })
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(runnerPinFromConfig(stored)).toEqual({ ref, files })
	})

	it('refuses a manifest whose hash does not match, leaving the pin untouched', async () => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ runner_ref: REF, runner_sha256: SHA }))
		serve('box-runner.mjs', 'runner')
		serve('lib/util.mjs', 'tampered')
		const res = await pinRunner(env, {
			ref,
			files: { 'box-runner.mjs': await sha256('runner'), 'lib/util.mjs': await sha256('util') },
		})
		expect(res).toMatchObject({
			status: 409,
			body: { error: 'sha256_mismatch', path: 'lib/util.mjs' },
		})
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(runnerPinFromConfig(stored)).toEqual(PIN)
	})

	it('fails with 502 when a manifest file is missing upstream', async () => {
		serve('box-runner.mjs', 'runner')
		fetchMock
			.get(base)
			.intercept({ path: `/abel30567/fermi-daemon/${ref}/lib/gone.mjs` })
			.reply(404, 'nope')
		const res = await pinRunner(env, { ref, files: ['lib/gone.mjs'] })
		expect(res).toMatchObject({ status: 502, body: { error: 'fetch_404', path: 'lib/gone.mjs' } })
	})
})
