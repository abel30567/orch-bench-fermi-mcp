import { env, fetchMock } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
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
})

describe('runner pin manifest', () => {
	beforeAll(setupFleetSchema)

	it('a legacy single-file pin reads as a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'b'.repeat(64) })).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: 'b'.repeat(64), runner_files: null }),
		).toEqual({ ref: 'v1', files: PIN.files })
	})

	it('runner_files is the whole manifest', () => {
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: 'b'.repeat(64),
				runner_files: MANIFEST.files,
			}),
		).toEqual(MANIFEST)
	})

	it.each([
		['unset ref', { runner_sha256: 'b'.repeat(64) }],
		['unset sha', { runner_ref: REF, runner_sha256: null }],
		['bad sha', { runner_ref: REF, runner_sha256: 'xyz' }],
		['quote in ref', { runner_ref: "a'b", runner_sha256: 'b'.repeat(64) }],
		[
			'manifest without box-runner.mjs',
			{ runner_ref: REF, runner_files: { 'lib/util.mjs': 'd'.repeat(64) } },
		],
		['empty manifest', { runner_ref: REF, runner_files: {} }],
		['array manifest', { runner_ref: REF, runner_files: ['box-runner.mjs'] }],
		[
			'bad hash in manifest',
			{ runner_ref: REF, runner_files: { ...MANIFEST.files, 'lib/util.mjs': 'nope' } },
		],
		...[
			'../x.mjs',
			'/etc/passwd',
			'lib/../../x',
			'lib//x',
			".x'; rm -rf /",
			'lib/.hidden',
			'a b',
		].map((p) => [
			`unsafe path ${p}`,
			{ runner_ref: REF, runner_files: { ...MANIFEST.files, [p]: 'e'.repeat(64) } },
		]),
	] as [string, Record<string, unknown>][])('%s → null', (_, config) => {
		expect(runnerPinFromConfig(config)).toBeNull()
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'lib/util.mjs': 'd'.repeat(64) } }),
		).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { ...PIN.files, '../x': 'd'.repeat(64) } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': 'short' } })).toThrow()
		expect(() => runnerFetchScript({ ref: "x'y", files: PIN.files })).toThrow()
	})

	it('fetches every file at the pinned ref and verifies every hash before installing', () => {
		const script = runnerFetchScript(MANIFEST)
		const verifyAt = script.indexOf('sha256sum -c')
		const installAt = script.indexOf('mv ')
		expect(verifyAt).toBeGreaterThan(-1)
		expect(verifyAt).toBeLessThan(installAt)
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(runnerUrl(REF, path))
			expect(script).toContain(`'${sha}  /opt/fermi/.runner-stage/${path}'`)
			expect(script).toContain(`'/opt/fermi/${path}'`)
			// Every download happens before verification.
			expect(script.indexOf(runnerUrl(REF, path))).toBeLessThan(verifyAt)
		}
	})

	it('user-data verifies every manifest file BEFORE materializing the box token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const sha of Object.values(MANIFEST.files)) {
			expect(script.indexOf(sha)).toBeGreaterThan(-1)
			expect(script.indexOf(sha)).toBeLessThan(tokenAt)
		}
	})

	it('dispatchProvision treats an invalid manifest as unset', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: REF,
				runner_sha256: 'b'.repeat(64),
				runner_files: { 'lib/util.mjs': 'd'.repeat(64) },
			}),
		)
		expect(await dispatchProvision(env, agentRow('ca_badmanifest'))).toMatchObject({
			dispatched: false,
			reason: 'runner_pin_unset',
		})
	})

	it.each([
		['legacy single-file pin', { runner_ref: REF, runner_sha256: 'b'.repeat(64) }],
		[
			'manifest pin',
			{ runner_ref: REF, runner_sha256: 'b'.repeat(64), runner_files: MANIFEST.files },
		],
	])('dispatchProvision passes the pin gate with a %s', async (_, pin) => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ default_env: 'pin-env', ...pin }))
		await env.FERMI_KV.put(
			'cloudenv:pin-env',
			JSON.stringify({ name: 'pin-env', image_ref: 'ami-1' }),
		)
		expect(await dispatchProvision(env, agentRow('ca_pinned'))).toEqual({
			dispatched: false,
			reason: 'aws_credentials_missing',
		})
	})
})

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	const SHA_REF = 'abc1234'
	const BODIES: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/claude.mjs': 'export const h = 1',
		'lib/util.mjs': 'export const u = 1',
	}

	beforeAll(() => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		fetchMock
			.get('https://raw.githubusercontent.com')
			.intercept({ path: (p) => p.startsWith(`/abel30567/fermi-daemon/${SHA_REF}/`) })
			.reply((opts) => {
				const path = opts.path.slice(`/abel30567/fermi-daemon/${SHA_REF}/`.length)
				return path in BODIES
					? { statusCode: 200, data: BODIES[path] }
					: { statusCode: 404, data: 'nope' }
			})
			.persist()
	})

	beforeEach(async () => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ region: 'us-west-2' }))
	})

	const stored = async () => JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')

	it('a legacy single-file pin hashes box-runner.mjs and clears any manifest', async () => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ runner_files: { stale: 'x' } }))
		const res = await pinRunner(env, { ref: SHA_REF })
		const sha = await sha256(BODIES['box-runner.mjs'])
		expect(res.status).toBe(200)
		expect(res.body).toMatchObject({ ok: true, ref: SHA_REF, sha256: sha })
		expect(await stored()).toMatchObject({
			runner_ref: SHA_REF,
			runner_sha256: sha,
			runner_files: null,
		})
		expect(runnerPinFromConfig(await stored())).toEqual({
			ref: SHA_REF,
			files: { 'box-runner.mjs': sha },
		})
	})

	it('a path list is fetched, hashed and stored as the manifest', async () => {
		const res = await pinRunner(env, { ref: SHA_REF, files: Object.keys(BODIES) })
		expect(res.status).toBe(200)
		const files = Object.fromEntries(
			await Promise.all(Object.entries(BODIES).map(async ([p, b]) => [p, await sha256(b)])),
		)
		expect(res.body.files).toEqual(files)
		const config = await stored()
		expect(config).toMatchObject({ region: 'us-west-2', runner_ref: SHA_REF, runner_files: files })
		expect(runnerPinFromConfig(config)).toEqual({ ref: SHA_REF, files })
	})

	it('a { path: sha256 } manifest is accepted when every served file matches', async () => {
		const files = Object.fromEntries(
			await Promise.all(Object.entries(BODIES).map(async ([p, b]) => [p, await sha256(b)])),
		)
		const res = await pinRunner(env, { ref: SHA_REF, files })
		expect(res.status).toBe(200)
		expect((await stored()).runner_files).toEqual(files)
	})

	it('refuses a manifest whose hash does not match the served file, storing nothing', async () => {
		const files = {
			'box-runner.mjs': await sha256(BODIES['box-runner.mjs']),
			'lib/util.mjs': 'f'.repeat(64),
		}
		const res = await pinRunner(env, { ref: SHA_REF, files })
		expect(res.status).toBe(409)
		expect(res.body).toMatchObject({ ok: false, error: 'sha256_mismatch', path: 'lib/util.mjs' })
		expect(await stored()).toEqual({ region: 'us-west-2' })
	})

	it('returns 502 when a manifest file is missing at the ref', async () => {
		const res = await pinRunner(env, { ref: SHA_REF, files: ['box-runner.mjs', 'lib/missing.mjs'] })
		expect(res.status).toBe(502)
		expect(res.body).toMatchObject({ ok: false, error: 'fetch_404', path: 'lib/missing.mjs' })
		expect(await stored()).toEqual({ region: 'us-west-2' })
	})

	it.each([
		['missing ref', {}],
		['non-sha ref', { ref: 'main' }],
		['files as string', { ref: SHA_REF, files: 'box-runner.mjs' }],
		['files without box-runner.mjs', { ref: SHA_REF, files: ['lib/util.mjs'] }],
		['empty file list', { ref: SHA_REF, files: [] }],
		['unsafe path', { ref: SHA_REF, files: ['box-runner.mjs', '../etc/passwd'] }],
		['non-string path', { ref: SHA_REF, files: ['box-runner.mjs', 7] }],
		['bad sha in manifest', { ref: SHA_REF, files: { 'box-runner.mjs': 'nope' } }],
	])('400 on %s', async (_, body) => {
		const res = await pinRunner(env, body)
		expect(res.status).toBe(400)
		expect(res.body.ok).toBe(false)
		expect(await stored()).toEqual({ region: 'us-west-2' })
	})
})
