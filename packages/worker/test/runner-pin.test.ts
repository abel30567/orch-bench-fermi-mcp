import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import { bootstrapUserData } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'

const REF = 'a'.repeat(40)
const H1 = '1'.repeat(64)
const H2 = '2'.repeat(64)

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('runnerPinFromConfig', () => {
	it('reads a legacy single-file pin as a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: H1 })).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': H1 },
		})
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: H1, runner_files: null })).toEqual(
			{ ref: REF, files: { 'box-runner.mjs': H1 } },
		)
	})

	it('reads a multi-file manifest', () => {
		const files = { 'box-runner.mjs': H1, 'harness/claude.mjs': H2 }
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: files })).toEqual({
			ref: REF,
			files,
		})
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: H1, runner_files: files }),
		).toEqual({ ref: REF, files })
	})

	it('returns null when unset or invalid', () => {
		expect(runnerPinFromConfig({})).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF })).toBeNull()
		expect(runnerPinFromConfig({ runner_sha256: H1 })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: "x'; rm -rf /", runner_sha256: H1 })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'nothex' })).toBeNull()
		// manifest must contain box-runner.mjs
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: { 'lib/a.mjs': H1 } })).toBeNull()
		// unsafe paths
		for (const bad of [
			'../x.mjs',
			'/etc/passwd',
			'lib/../x.mjs',
			'a b.mjs',
			'.hidden',
			"x'.mjs",
			'lib//x.mjs',
		]) {
			expect(
				runnerPinFromConfig({ runner_ref: REF, runner_files: { 'box-runner.mjs': H1, [bad]: H2 } }),
			).toBeNull()
		}
		// legacy hash disagreeing with the manifest entry
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: H2,
				runner_files: { 'box-runner.mjs': H1 },
			}),
		).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: [] })).toBeNull()
	})
})

describe('runnerFetchScript', () => {
	it('fetches and verifies every file before installing any', () => {
		const script = runnerFetchScript({
			ref: REF,
			files: { 'box-runner.mjs': H1, 'harness/claude.mjs': H2 },
		})
		const lines = script.split('\n')
		const lastCheck = lines.findLastIndex((l) => l.includes('sha256sum -c'))
		const firstMv = lines.findIndex((l) => l.startsWith('mv '))
		expect(lastCheck).toBeGreaterThan(-1)
		expect(firstMv).toBeGreaterThan(lastCheck)
		expect(script).toContain(runnerUrl(REF, 'harness/claude.mjs'))
		expect(script).toContain(`echo '${H2}  /opt/fermi/.runner.new/harness/claude.mjs'`)
		expect(script).toContain(
			"mv '/opt/fermi/.runner.new/box-runner.mjs' '/opt/fermi/box-runner.mjs'",
		)
		expect(script).toContain('--retry 4')
	})

	it('throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/a.mjs': H1 } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': H1, '../a.mjs': H1 } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: "'", files: { 'box-runner.mjs': H1 } })).toThrow()
	})

	it('bootstrapUserData verifies the manifest before the box token lands', () => {
		const data = bootstrapUserData({
			boxId: 'box-1',
			agentId: 'ca_1',
			queue: 'agent:ca_1',
			route: 'claude',
			ttlSeconds: 600,
			mcpBaseUrl: null,
			boxToken: 'box-1.secret',
			claudeModel: null,
			runnerPin: { ref: REF, files: { 'box-runner.mjs': H1, 'lib/log.mjs': H2 } },
		})
		expect(data.indexOf(H2)).toBeGreaterThan(-1)
		expect(data.indexOf(H2)).toBeLessThan(data.indexOf('FERMI_BOX_TOKEN'))
	})
})

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	const RAW = 'https://raw.githubusercontent.com'
	const BASE = `/abel30567/fermi-daemon/${REF}`
	const bodies: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/claude.mjs': 'export const h = 1',
		'lib/log.mjs': 'export const log = 1',
	}
	const serve = (path: string) =>
		fetchMock
			.get(RAW)
			.intercept({ path: `${BASE}/${path}` })
			.reply(200, bodies[path])

	beforeEach(async () => {
		await env.FERMI_KV.delete('fleet:config')
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	it('legacy single-file pin: hashes box-runner.mjs only', async () => {
		serve('box-runner.mjs')
		const res = await pinRunner(env, { ref: REF })
		const sha = await sha256(bodies['box-runner.mjs'])
		expect(res).toMatchObject({ status: 200, body: { ok: true, ref: REF, sha256: sha } })
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(stored).toMatchObject({ runner_ref: REF, runner_sha256: sha })
		expect(runnerPinFromConfig(stored)).toEqual({ ref: REF, files: { 'box-runner.mjs': sha } })
	})

	it('pins a list of paths, always including box-runner.mjs, keeping other config', async () => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ instance_type: 't3.medium' }))
		serve('box-runner.mjs')
		serve('harness/claude.mjs')
		serve('lib/log.mjs')
		const res = await pinRunner(env, { ref: REF, files: ['harness/claude.mjs', 'lib/log.mjs'] })
		expect(res.status).toBe(200)
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(stored.instance_type).toBe('t3.medium')
		expect(runnerPinFromConfig(stored)).toEqual({
			ref: REF,
			files: {
				'box-runner.mjs': await sha256(bodies['box-runner.mjs']),
				'harness/claude.mjs': await sha256(bodies['harness/claude.mjs']),
				'lib/log.mjs': await sha256(bodies['lib/log.mjs']),
			},
		})
	})

	it('accepts a {path: sha256} manifest and refuses when a fetched file disagrees', async () => {
		serve('box-runner.mjs')
		serve('lib/log.mjs')
		const files = {
			'box-runner.mjs': await sha256(bodies['box-runner.mjs']),
			'lib/log.mjs': await sha256(bodies['lib/log.mjs']),
		}
		expect((await pinRunner(env, { ref: REF, files })).status).toBe(200)

		await env.FERMI_KV.delete('fleet:config')
		serve('box-runner.mjs')
		serve('lib/log.mjs')
		const res = await pinRunner(env, { ref: REF, files: { ...files, 'lib/log.mjs': H2 } })
		expect(res).toMatchObject({ status: 409, body: { ok: false, path: 'lib/log.mjs' } })
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('400 on a bad ref or malformed files, without fetching', async () => {
		expect((await pinRunner(env, {})).status).toBe(400)
		expect((await pinRunner(env, { ref: 'main' })).status).toBe(400)
		for (const files of [
			[],
			['../x.mjs'],
			[42],
			'box-runner.mjs',
			{ 'lib/a.mjs': H1 },
			{ 'box-runner.mjs': 'nothex' },
			{ 'box-runner.mjs': H1, '/etc/passwd': H1 },
		]) {
			expect((await pinRunner(env, { ref: REF, files })).status).toBe(400)
		}
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('502 when any file is missing at the ref', async () => {
		serve('box-runner.mjs')
		fetchMock
			.get(RAW)
			.intercept({ path: `${BASE}/lib/log.mjs` })
			.reply(404, 'nope')
		const res = await pinRunner(env, { ref: REF, files: ['lib/log.mjs'] })
		expect(res).toMatchObject({ status: 502, body: { error: 'fetch_404', path: 'lib/log.mjs' } })
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})
})
