import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const REF = 'a'.repeat(40)
const SHA_A = 'b'.repeat(64)
const SHA_B = 'c'.repeat(64)
const SHA_C = 'd'.repeat(64)
const PIN = { ref: REF, files: { 'box-runner.mjs': SHA_A } }
const MANIFEST = { 'box-runner.mjs': SHA_A, 'harness/claude.mjs': SHA_B, 'lib/util.mjs': SHA_C }

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
		expect(script).toContain(SHA_A)
		expect(script).not.toContain('/main/') // no floating branch
		expect(script).not.toContain('|| true') // fail closed, no baked-copy fallback
	})

	it('user-data verifies the runner BEFORE materializing the box token', () => {
		const script = userData()
		const verifyAt = script.indexOf(SHA_A)
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		expect(verifyAt).toBeGreaterThan(-1)
		expect(tokenAt).toBeGreaterThan(-1)
		expect(verifyAt).toBeLessThan(tokenAt)
	})

	it('user-data fetches and verifies every manifest file BEFORE the box token', () => {
		const script = userData({ runnerPin: { ref: REF, files: MANIFEST } })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const [path, sha] of Object.entries(MANIFEST)) {
			expect(script).toContain(runnerUrl(REF, path))
			const verifyAt = script.indexOf(
				`echo '${sha}  /opt/fermi/.runner.new/${path}' | sha256sum -c -`,
			)
			expect(verifyAt).toBeGreaterThan(-1)
			expect(verifyAt).toBeLessThan(tokenAt)
			// Installed into the same relative layout only after every file verified.
			const installAt = script.indexOf(`mv '/opt/fermi/.runner.new/${path}' '/opt/fermi/${path}'`)
			expect(installAt).toBeGreaterThan(script.lastIndexOf('sha256sum -c -'))
			expect(installAt).toBeLessThan(tokenAt)
		}
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		const bad =
			(files: Record<string, string>, ref = REF) =>
			() =>
				runnerFetchScript({ ref, files })
		expect(bad({})).toThrow()
		expect(bad({ 'lib/util.mjs': SHA_C })).toThrow() // no box-runner.mjs
		expect(bad({ 'box-runner.mjs': SHA_A, '../evil.mjs': SHA_B })).toThrow()
		expect(bad({ 'box-runner.mjs': SHA_A, '/etc/passwd': SHA_B })).toThrow()
		expect(bad({ 'box-runner.mjs': SHA_A, "lib/x';rm -rf /;'": SHA_B })).toThrow()
		expect(bad({ 'box-runner.mjs': 'not-a-sha' })).toThrow()
		expect(bad(PIN.files, "v1'; curl evil")).toThrow()
	})

	it('runnerPinFromConfig: legacy single-file pin, manifest, and unset/invalid → null', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_A })).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_A, runner_files: null }),
		).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_A, runner_files: MANIFEST }),
		).toEqual({ ref: REF, files: MANIFEST })
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'short' })).toBeNull()
		// An invalid manifest never falls back to the legacy hash.
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: SHA_A,
				runner_files: { 'lib/util.mjs': SHA_C },
			}),
		).toBeNull()
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: SHA_A,
				runner_files: { 'box-runner.mjs': SHA_A, '../x': SHA_B },
			}),
		).toBeNull()
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_A, runner_files: [] }),
		).toBeNull()
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

	it('dispatchProvision refuses launch when the manifest is invalid', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: REF,
				runner_sha256: SHA_A,
				runner_files: { 'lib/util.mjs': SHA_C },
			}),
		)
		const out = await dispatchProvision(env, {
			id: 'ca_badmanifest',
			route: 'claude',
			queue: 'default',
			box_id: null,
			ttl_seconds: 3600,
		} as unknown as CloudAgentRow)
		expect(out).toEqual({ dispatched: false, reason: 'runner_pin_invalid' })
	})

	it('dispatchProvision accepts a legacy single-file pin and a manifest pin', async () => {
		for (const pin of [
			{ runner_ref: REF, runner_sha256: SHA_A },
			{ runner_ref: REF, runner_sha256: SHA_A, runner_files: MANIFEST },
		]) {
			// No environment configured: passing the pin gate is what reaches this reason.
			await env.FERMI_KV.put('fleet:config', JSON.stringify(pin))
			const out = await dispatchProvision(env, {
				id: 'ca_legacy',
				route: 'claude',
				queue: 'default',
				box_id: null,
				ttl_seconds: 3600,
			} as unknown as CloudAgentRow)
			expect(out).toEqual({ dispatched: false, reason: 'no_environment_configured' })
		}
	})
})

describe('POST /admin/fleet/pin-runner manifest (pinRunner)', () => {
	const RAW = 'https://raw.githubusercontent.com'
	const SHA = 'abcdef1'
	const BODIES: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/claude.mjs': 'export const h = 1',
		'lib/util.mjs': 'export const u = 1',
	}
	const hex = async (s: string) =>
		[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
			.map((x) => x.toString(16).padStart(2, '0'))
			.join('')
	const serve = (...paths: string[]) => {
		for (const p of paths)
			fetchMock
				.get(RAW)
				.intercept({ path: `/abel30567/fermi-daemon/${SHA}/${p}` })
				.reply(200, BODIES[p])
	}
	const stored = async () => JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')

	beforeEach(async () => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ default_env: 'keep-me' }))
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	it('legacy body (ref only) pins box-runner.mjs and stays backward compatible', async () => {
		serve('box-runner.mjs')
		const res = await pinRunner(env, { ref: SHA })
		const sha = await hex(BODIES['box-runner.mjs'])
		expect(res.status).toBe(200)
		expect(res.body).toMatchObject({ ok: true, ref: SHA, sha256: sha })
		const cfg = await stored()
		expect(cfg).toMatchObject({ default_env: 'keep-me', runner_ref: SHA, runner_sha256: sha })
		expect(runnerPinFromConfig(cfg)).toEqual({ ref: SHA, files: { 'box-runner.mjs': sha } })
	})

	it('files as a path list: fetches and hashes each, always including box-runner.mjs', async () => {
		serve('box-runner.mjs', 'harness/claude.mjs', 'lib/util.mjs')
		const res = await pinRunner(env, { ref: SHA, files: ['harness/claude.mjs', 'lib/util.mjs'] })
		expect(res.status).toBe(200)
		const files = Object.fromEntries(
			await Promise.all(Object.entries(BODIES).map(async ([p, b]) => [p, await hex(b)])),
		)
		expect(res.body.files).toEqual(files)
		const cfg = await stored()
		expect(cfg.runner_files).toEqual(files)
		expect(cfg.runner_sha256).toBe(files['box-runner.mjs'])
		expect(runnerPinFromConfig(cfg)).toEqual({ ref: SHA, files })
	})

	it('files as a manifest: stores it when every served hash matches', async () => {
		serve('box-runner.mjs', 'lib/util.mjs')
		const manifest = {
			'box-runner.mjs': await hex(BODIES['box-runner.mjs']),
			'lib/util.mjs': await hex(BODIES['lib/util.mjs']),
		}
		const res = await pinRunner(env, { ref: SHA, files: manifest })
		expect(res.status).toBe(200)
		expect((await stored()).runner_files).toEqual(manifest)
	})

	it('files as a manifest: a served hash mismatch is refused and nothing is stored', async () => {
		serve('box-runner.mjs', 'lib/util.mjs')
		const res = await pinRunner(env, {
			ref: SHA,
			files: { 'box-runner.mjs': await hex(BODIES['box-runner.mjs']), 'lib/util.mjs': SHA_C },
		})
		expect(res.status).toBe(409)
		expect(res.body).toMatchObject({ ok: false, error: 'sha256_mismatch', path: 'lib/util.mjs' })
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})

	it('a missing file fails the pin with 502 and nothing is stored', async () => {
		serve('box-runner.mjs')
		fetchMock
			.get(RAW)
			.intercept({ path: `/abel30567/fermi-daemon/${SHA}/lib/util.mjs` })
			.reply(404, 'nope')
		const res = await pinRunner(env, { ref: SHA, files: ['lib/util.mjs'] })
		expect(res.status).toBe(502)
		expect(res.body).toMatchObject({ ok: false, path: 'lib/util.mjs' })
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})

	it('400 on a bad ref or malformed files, without fetching', async () => {
		for (const body of [
			{},
			{ ref: 'main' },
			{ ref: 'ABCDEF1' },
			{ ref: SHA, files: 'box-runner.mjs' },
			{ ref: SHA, files: ['../etc/passwd'] },
			{ ref: SHA, files: ['/abs.mjs'] },
			{ ref: SHA, files: [42] },
			{ ref: SHA, files: { 'lib/util.mjs': SHA_C } }, // manifest without box-runner.mjs
			{ ref: SHA, files: { 'box-runner.mjs': 'xyz' } },
			{ ref: SHA, files: {} },
			{ ref: SHA, files: Array.from({ length: 40 }, (_, i) => `lib/f${i}.mjs`) },
		]) {
			const res = await pinRunner(env, body)
			expect(res.status, JSON.stringify(body)).toBe(400)
			expect(res.body.ok).toBe(false)
		}
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})
})
