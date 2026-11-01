import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const SHA = 'b'.repeat(64)
const PIN = { ref: 'a'.repeat(40), files: { 'box-runner.mjs': SHA } }
const MANIFEST = {
	'box-runner.mjs': SHA,
	'harness/index.mjs': 'c'.repeat(64),
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

	it('dispatchProvision refuses launch when the runner manifest is invalid', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: 'a'.repeat(40),
				runner_sha256: SHA,
				runner_files: { '../evil.mjs': SHA, 'box-runner.mjs': SHA },
			}),
		)
		const out = await dispatchProvision(env, {
			id: 'ca_badmanifest',
			box_id: null,
			ttl_seconds: 3600,
		} as unknown as CloudAgentRow)
		expect(out).toMatchObject({ dispatched: false, reason: 'runner_pin_unset' })
	})
})

describe('runner pin manifest', () => {
	const ref = 'a'.repeat(40)

	it('reads a legacy single-file pin as a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: ref, runner_sha256: SHA })).toEqual({
			ref,
			files: { 'box-runner.mjs': SHA },
		})
		expect(
			runnerPinFromConfig({ runner_ref: ref, runner_sha256: SHA, runner_files: null }),
		).toEqual({ ref, files: { 'box-runner.mjs': SHA } })
	})

	it('reads a manifest, which wins over runner_sha256', () => {
		expect(
			runnerPinFromConfig({
				runner_ref: ref,
				runner_sha256: 'e'.repeat(64),
				runner_files: MANIFEST,
			}),
		).toEqual({ ref, files: MANIFEST })
	})

	it('returns null when unset or invalid', () => {
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: ref, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_files: MANIFEST })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: "x'; rm -rf /", runner_sha256: SHA })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: ref, runner_sha256: 'nothex' })).toBeNull()
		const bad = (files: Record<string, string>) =>
			runnerPinFromConfig({ runner_ref: ref, runner_sha256: SHA, runner_files: files })
		expect(bad({ 'harness/index.mjs': SHA })).toBeNull() // no box-runner.mjs
		for (const path of [
			'../x.mjs',
			'/etc/passwd',
			'a//b.mjs',
			'lib/../x.mjs',
			'./x',
			"x'y",
			'.hidden',
		])
			expect(bad({ 'box-runner.mjs': SHA, [path]: SHA }), path).toBeNull()
		expect(bad({ 'box-runner.mjs': 'XYZ' })).toBeNull()
	})

	it('fetch script fetches and verifies every file before installing any', () => {
		const script = runnerFetchScript({ ref, files: MANIFEST })
		const firstMv = script.indexOf('mv ')
		const verifyAt = script.indexOf('sha256sum -c')
		for (const [path, sha] of Object.entries(MANIFEST)) {
			expect(script).toContain(runnerUrl(ref, path))
			expect(script.indexOf(runnerUrl(ref, path))).toBeLessThan(verifyAt)
			expect(script).toContain(`${sha}  ${path}`)
			expect(script).toContain(`'/opt/fermi/${path}'`)
		}
		expect(verifyAt).toBeLessThan(firstMv)
	})

	it('fetch script throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref, files: { 'lib/util.mjs': SHA } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref, files: { 'box-runner.mjs': SHA, '../x': SHA } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: 'bad ref', files: { 'box-runner.mjs': SHA } })).toThrow()
	})

	it('runnerUrl defaults to box-runner.mjs', () => {
		expect(runnerUrl(ref)).toBe(runnerUrl(ref, 'box-runner.mjs'))
		expect(runnerUrl(ref, 'lib/util.mjs')).toMatch(new RegExp(`/${ref}/lib/util\\.mjs$`))
	})
})

describe('pinRunner', () => {
	const ref = 'a'.repeat(40)
	const bodies: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/index.mjs': 'export const h = 1',
		'lib/util.mjs': 'export const u = 1',
	}
	const hex = async (s: string) =>
		[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
			.map((x) => x.toString(16).padStart(2, '0'))
			.join('')
	let real: Record<string, string>

	beforeAll(async () => {
		real = {}
		for (const [p, b] of Object.entries(bodies)) real[p] = await hex(b)
	})
	beforeEach(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		for (const [p, b] of Object.entries(bodies)) {
			fetchMock
				.get('https://raw.githubusercontent.com')
				.intercept({ path: `/abel30567/fermi-daemon/${ref}/${p}` })
				.reply(200, b)
				.persist()
		}
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ default_env: 'keep-me' }))
	})
	afterEach(() => fetchMock.deactivate())

	const stored = async () => JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')

	it('legacy single-file pin hashes box-runner.mjs and boots via runnerPinFromConfig', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'keep-me',
				runner_files: { 'box-runner.mjs': 'f'.repeat(64) },
			}),
		)
		const out = await pinRunner(env, { ref })
		expect(out.status).toBe(200)
		expect(out.body).toMatchObject({ ok: true, ref, sha256: real['box-runner.mjs'] })
		const cfg = await stored()
		expect(cfg).toMatchObject({
			default_env: 'keep-me',
			runner_ref: ref,
			runner_sha256: real['box-runner.mjs'],
			runner_files: null, // stale manifest cleared
		})
		expect(runnerPinFromConfig(cfg)).toEqual({
			ref,
			files: { 'box-runner.mjs': real['box-runner.mjs'] },
		})
	})

	it('accepts a manifest whose hashes match the files at ref', async () => {
		const out = await pinRunner(env, { ref, files: real })
		expect(out.status).toBe(200)
		expect(out.body).toMatchObject({ ok: true, files: real })
		const cfg = await stored()
		expect(cfg).toMatchObject({ runner_ref: ref, runner_files: real })
		expect(runnerPinFromConfig(cfg)).toEqual({ ref, files: real })
	})

	it('refuses a manifest whose hash does not match, storing nothing', async () => {
		const out = await pinRunner(env, { ref, files: { ...real, 'lib/util.mjs': 'e'.repeat(64) } })
		expect(out.status).toBe(409)
		expect(out.body).toMatchObject({ ok: false, error: 'sha256_mismatch', path: 'lib/util.mjs' })
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})

	it('returns 400 on a bad ref or malformed files', async () => {
		for (const body of [
			{},
			{ ref: 'main' },
			{ ref: 'not a sha' },
			{ ref, files: 'box-runner.mjs' },
			{ ref, files: ['box-runner.mjs'] },
			{ ref, files: null },
			{ ref, files: { 'lib/util.mjs': real['lib/util.mjs'] } },
			{ ref, files: { ...real, '../evil.mjs': real['lib/util.mjs'] } },
			{ ref, files: { 'box-runner.mjs': 'short' } },
		]) {
			const out = await pinRunner(env, body)
			expect(out.status, JSON.stringify(body)).toBe(400)
			expect(out.body.ok).toBe(false)
		}
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})

	it('returns 502 when a manifest file cannot be fetched', async () => {
		fetchMock
			.get('https://raw.githubusercontent.com')
			.intercept({ path: `/abel30567/fermi-daemon/${ref}/lib/missing.mjs` })
			.reply(404, 'nope')
		const out = await pinRunner(env, { ref, files: { ...real, 'lib/missing.mjs': SHA } })
		expect(out.status).toBe(502)
		expect(await stored()).toEqual({ default_env: 'keep-me' })
	})
})
