import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const REF = 'a'.repeat(40)
const PIN = { ref: REF, files: { 'box-runner.mjs': 'b'.repeat(64) } }
const MANIFEST = {
	ref: REF,
	files: {
		'box-runner.mjs': 'b'.repeat(64),
		'harness/claude.mjs': 'c'.repeat(64),
		'lib/util.mjs': 'd'.repeat(64),
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
		expect(script).toContain(PIN.files['box-runner.mjs'])
		expect(script).not.toContain('/main/') // no floating branch
		expect(script).not.toContain('|| true') // fail closed, no baked-copy fallback
	})

	it('user-data verifies the runner BEFORE materializing the box token', () => {
		const script = userData()
		const verifyAt = script.indexOf(PIN.files['box-runner.mjs'])
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		expect(verifyAt).toBeGreaterThan(-1)
		expect(tokenAt).toBeGreaterThan(-1)
		expect(verifyAt).toBeLessThan(tokenAt)
	})

	it('user-data verifies every manifest file BEFORE materializing the box token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(runnerUrl(REF, path))
			const verifyAt = script.indexOf(sha)
			expect(verifyAt).toBeGreaterThan(-1)
			expect(verifyAt).toBeLessThan(tokenAt)
		}
	})

	it('fetch script verifies every file before installing any', () => {
		const lines = runnerFetchScript(MANIFEST).split('\n')
		const lastVerify = lines.findLastIndex((l) => l.includes('sha256sum -c'))
		const firstInstall = lines.findIndex((l) => l.startsWith('mv '))
		expect(lines.filter((l) => l.includes('sha256sum -c'))).toHaveLength(3)
		expect(lastVerify).toBeLessThan(firstInstall)
		expect(lines).toContain(
			"mv '/opt/fermi/.runner-staging/harness/claude.mjs' '/opt/fermi/harness/claude.mjs'",
		)
	})

	it('fetch script throws on an invalid manifest', () => {
		const bad = (files: Record<string, string>) => () => runnerFetchScript({ ref: REF, files })
		expect(bad({ 'lib/util.mjs': 'd'.repeat(64) })).toThrow(/box-runner\.mjs/)
		expect(bad({ ...PIN.files, '../etc/passwd': 'd'.repeat(64) })).toThrow(/unsafe path/)
		expect(bad({ ...PIN.files, 'lib/x.mjs': "'; rm -rf / #" })).toThrow(/sha256/)
		expect(() => runnerFetchScript({ ref: "x'; reboot #", files: PIN.files })).toThrow(/ref/)
	})

	it('user-data has no unpinned curl of main', () => {
		expect(userData()).not.toContain('fermi-daemon/main/')
	})

	it('runnerPinFromConfig: legacy single-file pin becomes a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'b'.repeat(64) })).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'b'.repeat(64), runner_files: null }),
		).toEqual(PIN)
	})

	it('runnerPinFromConfig: manifest wins over runner_sha256', () => {
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: 'b'.repeat(64),
				runner_files: MANIFEST.files,
			}),
		).toEqual(MANIFEST)
	})

	it('runnerPinFromConfig: unset or invalid pins are null', () => {
		const sha = 'b'.repeat(64)
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: sha })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'nothex' })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: 'x y', runner_sha256: sha })).toBeNull()
		// A manifest must contain box-runner.mjs (no silent fallback to runner_sha256).
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: sha,
				runner_files: { 'lib/util.mjs': sha },
			}),
		).toBeNull()
		for (const unsafe of ['../x.mjs', '/etc/passwd', 'lib//x.mjs', 'lib/../x', '.hidden', 'a b']) {
			expect(
				runnerPinFromConfig({
					runner_ref: REF,
					runner_sha256: sha,
					runner_files: { 'box-runner.mjs': sha, [unsafe]: sha },
				}),
			).toBeNull()
		}
	})

	it('dispatchProvision accepts a legacy single-file pin', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'test-env', runner_ref: REF, runner_sha256: 'b'.repeat(64) }),
		)
		await env.FERMI_KV.put('cloudenv:test-env', JSON.stringify({ image_ref: 'ami-1' }))
		const out = await dispatchProvision(env, agentRow('ca_legacy'))
		// Past the pin gate; fails later only because the test has no AWS creds.
		expect(out.reason).toBe('aws_credentials_missing')
	})

	it('dispatchProvision refuses launch when the manifest is invalid', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: REF,
				runner_sha256: 'b'.repeat(64),
				runner_files: { 'box-runner.mjs': 'b'.repeat(64), '../evil.mjs': 'c'.repeat(64) },
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
		const out = await dispatchProvision(env, agentRow('ca_pinless'))
		expect(out.dispatched).toBe(false)
		expect(out.reason).toBe('runner_pin_unset')
	})
})

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	const SHA = '0123abc'
	const BODIES: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")\n',
		'harness/claude.mjs': 'export const h = 1\n',
		'lib/util.mjs': 'export const u = 1\n',
	}
	async function sha256(text: string): Promise<string> {
		const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
		return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
	}
	function serve(paths: string[], status = 200) {
		for (const p of paths) {
			fetchMock
				.get('https://raw.githubusercontent.com')
				.intercept({ path: `/abel30567/fermi-daemon/${SHA}/${p}` })
				.reply(status, status === 200 ? BODIES[p] : 'nope')
		}
	}
	const stored = async () => JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')

	beforeEach(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ default_env: 'keep-me' }))
	})
	afterEach(() => fetchMock.deactivate())

	it('legacy single-file pin: hashes box-runner.mjs, clears any manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'keep-me', runner_files: { stale: 'x' } }),
		)
		serve(['box-runner.mjs'])
		const out = await pinRunner(env, { ref: SHA })
		const sha = await sha256(BODIES['box-runner.mjs'])
		expect(out.status).toBe(200)
		expect(out.body).toMatchObject({ ok: true, ref: SHA, sha256: sha })
		expect(await stored()).toEqual({
			default_env: 'keep-me',
			runner_ref: SHA,
			runner_sha256: sha,
			runner_files: null,
		})
		expect(runnerPinFromConfig(await stored())).toEqual({
			ref: SHA,
			files: { 'box-runner.mjs': sha },
		})
	})

	it('path list: fetches and hashes every file, always including box-runner.mjs', async () => {
		serve(Object.keys(BODIES))
		const out = await pinRunner(env, { ref: SHA, files: ['harness/claude.mjs', 'lib/util.mjs'] })
		expect(out.status).toBe(200)
		const files = Object.fromEntries(
			await Promise.all(Object.entries(BODIES).map(async ([p, b]) => [p, await sha256(b)])),
		)
		expect(out.body.files).toEqual(files)
		const cfg = await stored()
		expect(cfg).toMatchObject({ runner_ref: SHA, runner_files: files })
		expect(cfg.runner_sha256).toBe(files['box-runner.mjs'])
		expect(runnerPinFromConfig(cfg)).toEqual({ ref: SHA, files })
	})

	it('manifest map: accepted when every served hash matches', async () => {
		serve(Object.keys(BODIES))
		const files = Object.fromEntries(
			await Promise.all(Object.entries(BODIES).map(async ([p, b]) => [p, await sha256(b)])),
		)
		const out = await pinRunner(env, { ref: SHA, files })
		expect(out.status).toBe(200)
		expect((await stored()).runner_files).toEqual(files)
	})

	it('manifest map: a hash mismatch refuses and stores nothing', async () => {
		serve(Object.keys(BODIES))
		const files = Object.fromEntries(
			await Promise.all(Object.entries(BODIES).map(async ([p, b]) => [p, await sha256(b)])),
		)
		files['lib/util.mjs'] = 'f'.repeat(64)
		const out = await pinRunner(env, { ref: SHA, files })
		expect(out.status).toBe(409)
		expect(out.body).toMatchObject({ ok: false, error: 'sha256_mismatch', path: 'lib/util.mjs' })
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})

	it('a missing file at the ref refuses and stores nothing', async () => {
		serve(['box-runner.mjs'])
		serve(['lib/util.mjs'], 404)
		const out = await pinRunner(env, { ref: SHA, files: ['lib/util.mjs'] })
		expect(out.status).toBe(502)
		expect(out.body).toMatchObject({ ok: false, error: 'fetch_404', path: 'lib/util.mjs' })
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})

	it('400 on a bad ref or malformed files, without fetching', async () => {
		const sha = 'a'.repeat(64)
		for (const body of [
			{},
			{ ref: 'main' },
			{ ref: "abc1234'; reboot" },
			{ ref: SHA, files: 'box-runner.mjs' },
			{ ref: SHA, files: ['../evil.mjs'] },
			{ ref: SHA, files: ['/etc/passwd'] },
			{ ref: SHA, files: [42] },
			{ ref: SHA, files: Array.from({ length: 65 }, (_, i) => `f${i}.mjs`) },
			{ ref: SHA, files: { 'lib/util.mjs': sha } },
			{ ref: SHA, files: { 'box-runner.mjs': 'nothex' } },
			{ ref: SHA, files: { 'box-runner.mjs': sha, '../x': sha } },
		]) {
			const out = await pinRunner(env, body)
			expect(out.status, JSON.stringify(body)).toBe(400)
			expect(out.body.ok).toBe(false)
		}
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})
})
