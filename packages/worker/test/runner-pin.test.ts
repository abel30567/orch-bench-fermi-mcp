import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pinRunner, updateFleetConfig } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const SHA = 'b'.repeat(64)
const SHA2 = 'c'.repeat(64)
const REF = 'a'.repeat(40)
const PIN = { ref: REF, files: { 'box-runner.mjs': SHA } }
const MANIFEST = { 'box-runner.mjs': SHA, 'harness/index.mjs': SHA2 }

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function serve(path: string, body: string, status = 200) {
	fetchMock
		.get('https://raw.githubusercontent.com')
		.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}` })
		.reply(status, body)
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

	it('dispatchProvision refuses launch when the stored manifest is invalid', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: 'v1',
				runner_sha256: SHA,
				runner_files: { 'box-runner.mjs': SHA, '../evil.mjs': SHA },
			}),
		)
		const out = await dispatchProvision(env, { id: 'ca_badpin' } as unknown as CloudAgentRow)
		expect(out).toMatchObject({ dispatched: false, reason: 'runner_pin_unset' })
	})
})

describe('runnerPinFromConfig', () => {
	it('reads a legacy single-file pin as a one-file manifest', () => {
		const legacy = { ref: 'v1', files: { 'box-runner.mjs': SHA } }
		expect(runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: SHA })).toEqual(legacy)
		expect(
			runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: SHA, runner_files: null }),
		).toEqual(legacy)
	})

	it('prefers the manifest', () => {
		expect(
			runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: SHA2, runner_files: MANIFEST }),
		).toEqual({ ref: 'v1', files: MANIFEST })
	})

	it.each([
		['no ref', { runner_ref: null, runner_sha256: SHA }],
		['no hash', { runner_ref: 'v1', runner_sha256: null }],
		['bad hash', { runner_ref: 'v1', runner_sha256: 'nope' }],
		['shell in ref', { runner_ref: "v1'; rm -rf /", runner_sha256: SHA }],
		['empty manifest', { runner_ref: 'v1', runner_files: {} }],
		['no entry file', { runner_ref: 'v1', runner_files: { 'lib/a.mjs': SHA } }],
		['array manifest', { runner_ref: 'v1', runner_files: [SHA] }],
	])('returns null for %s', (_label, config) => {
		expect(runnerPinFromConfig(config)).toBeNull()
	})

	it('does not fall back to runner_sha256 when the manifest is invalid', () => {
		expect(
			runnerPinFromConfig({
				runner_ref: 'v1',
				runner_sha256: SHA,
				runner_files: { 'box-runner.mjs': SHA, '../evil.mjs': SHA },
			}),
		).toBeNull()
	})

	it.each([
		'../evil.mjs',
		'lib/../../evil.mjs',
		'/etc/passwd',
		'lib//a.mjs',
		'lib/',
		'.hidden',
		"a'b.mjs",
		'a b.mjs',
		'$(id).mjs',
		'a\\b.mjs',
		'a\nb.mjs',
	])('rejects the unsafe path %j', (path) => {
		const files = { 'box-runner.mjs': SHA, [path]: SHA }
		expect(runnerPinFromConfig({ runner_ref: 'v1', runner_files: files })).toBeNull()
	})
})

describe('runnerFetchScript manifest', () => {
	it('fetches and verifies every file into the same relative layout', () => {
		const script = runnerFetchScript({ ref: REF, files: MANIFEST })
		for (const [path, sha] of Object.entries(MANIFEST)) {
			expect(script).toContain(runnerUrl(REF, path))
			expect(script).toContain(`${sha}  /opt/fermi.new/${path}`)
			expect(script).toContain(`'/opt/fermi/${path}'`)
		}
	})

	it('installs nothing until every file has been verified', () => {
		const script = runnerFetchScript({ ref: REF, files: MANIFEST })
		expect(script.indexOf('mv -f')).toBeGreaterThan(script.lastIndexOf('sha256sum -c'))
	})

	it.each([
		['missing entry', { ref: REF, files: { 'lib/a.mjs': SHA } }],
		['unsafe path', { ref: REF, files: { 'box-runner.mjs': SHA, '../a.mjs': SHA } }],
		['bad hash', { ref: REF, files: { 'box-runner.mjs': 'nope' } }],
		['bad ref', { ref: "x'; id; '", files: { 'box-runner.mjs': SHA } }],
	])('throws on %s', (_label, pin) => {
		expect(() => runnerFetchScript(pin)).toThrow()
	})

	it('user-data verifies every manifest file BEFORE materializing the box token', () => {
		const script = userData({ runnerPin: { ref: REF, files: MANIFEST } })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		expect(script.indexOf(SHA2)).toBeGreaterThan(-1)
		expect(script.indexOf(SHA2)).toBeLessThan(tokenAt)
		expect(script.lastIndexOf('mv -f')).toBeLessThan(tokenAt)
	})
})

describe('pinRunner', () => {
	const stored = async () => JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')

	beforeEach(async () => {
		await env.FERMI_KV.delete('fleet:config')
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	it('single-file pin hashes box-runner.mjs as before', async () => {
		serve('box-runner.mjs', 'runner')
		const res = await pinRunner(env, { ref: REF })
		const sha = await sha256('runner')
		expect(res.status).toBe(200)
		expect(res.body).toMatchObject({ ok: true, ref: REF, sha256: sha, bytes: 6 })
		const config = await stored()
		expect(config).toMatchObject({ runner_ref: REF, runner_sha256: sha, runner_files: null })
		expect(runnerPinFromConfig(config)?.files).toEqual({ 'box-runner.mjs': sha })
	})

	it('manifest pin verifies every file and stores the manifest', async () => {
		serve('box-runner.mjs', 'runner')
		serve('harness/index.mjs', 'harness')
		const files = {
			'box-runner.mjs': await sha256('runner'),
			'harness/index.mjs': await sha256('harness'),
		}
		const res = await pinRunner(env, { ref: REF, files })
		expect(res.status).toBe(200)
		expect(res.body).toMatchObject({ ok: true, files })
		const config = await stored()
		expect(config).toMatchObject({
			runner_ref: REF,
			runner_sha256: files['box-runner.mjs'],
			runner_files: files,
		})
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files })
	})

	it('a single-file re-pin clears a previous manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'node',
				runner_ref: 'f'.repeat(40),
				runner_sha256: SHA,
				runner_files: MANIFEST,
			}),
		)
		serve('box-runner.mjs', 'runner')
		expect((await pinRunner(env, { ref: REF })).status).toBe(200)
		const config = await stored()
		expect(config.default_env).toBe('node')
		expect(runnerPinFromConfig(config)?.files).toEqual({
			'box-runner.mjs': await sha256('runner'),
		})
	})

	it.each([
		['non-sha ref', { ref: 'main' }],
		['missing ref', {}],
		['null files', { ref: REF, files: null }],
		['array files', { ref: REF, files: ['box-runner.mjs'] }],
		['no entry file', { ref: REF, files: { 'lib/a.mjs': SHA } }],
		['unsafe path', { ref: REF, files: { 'box-runner.mjs': SHA, '../a.mjs': SHA } }],
		['bad hash', { ref: REF, files: { 'box-runner.mjs': 'nope' } }],
	])('returns 400 and stores nothing for %s', async (_label, input) => {
		const res = await pinRunner(env, input)
		expect(res.status).toBe(400)
		expect(res.body.ok).toBe(false)
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('refuses a manifest whose hash does not match the fetched file', async () => {
		serve('box-runner.mjs', 'runner')
		serve('harness/index.mjs', 'tampered')
		const res = await pinRunner(env, {
			ref: REF,
			files: { 'box-runner.mjs': await sha256('runner'), 'harness/index.mjs': SHA2 },
		})
		expect(res.status).toBe(409)
		expect(res.body).toMatchObject({ error: 'sha256_mismatch', path: 'harness/index.mjs' })
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('stores nothing when a manifest file cannot be fetched', async () => {
		serve('box-runner.mjs', 'runner')
		serve('harness/index.mjs', 'gone', 404)
		const res = await pinRunner(env, {
			ref: REF,
			files: { 'box-runner.mjs': await sha256('runner'), 'harness/index.mjs': SHA2 },
		})
		expect(res.status).toBe(502)
		expect(res.body).toMatchObject({ error: 'fetch_404', path: 'harness/index.mjs' })
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('the operator config endpoint cannot edit the manifest', async () => {
		expect(await updateFleetConfig(env, { runner_files: MANIFEST })).toMatchObject({ ok: false })
	})
})
