import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getFleetConfig, pinRunner } from '../src/lib/fleet-config.ts'
import { bootstrapUserData } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'

const REF = 'a'.repeat(40)
const H1 = '1'.repeat(64)
const H2 = '2'.repeat(64)

async function sha(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('runnerPinFromConfig', () => {
	it('maps a legacy single-file pin to a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: H1 })).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': H1 },
		})
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: H1, runner_files: null })).toEqual(
			{ ref: REF, files: { 'box-runner.mjs': H1 } },
		)
	})

	it('reads a manifest', () => {
		const files = { 'box-runner.mjs': H1, 'harness/claude.mjs': H2 }
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: H1, runner_files: files }),
		).toEqual({ ref: REF, files })
	})

	it('returns null when unset or invalid', () => {
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: "x'; rm -rf /", runner_sha256: H1 })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'nothex' })).toBeNull()
		// manifest must contain box-runner.mjs
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: { 'lib/a.mjs': H1 } })).toBeNull()
		for (const bad of [
			'../x.mjs',
			'/etc/passwd',
			'lib/../../x',
			'a b.mjs',
			"a'.mjs",
			'lib//a',
			'',
		]) {
			expect(
				runnerPinFromConfig({ runner_ref: REF, runner_files: { 'box-runner.mjs': H1, [bad]: H2 } }),
			).toBeNull()
		}
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_files: { 'box-runner.mjs': 'short' } }),
		).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: [] })).toBeNull()
		// entry hash disagreeing with runner_sha256 is a corrupt pin
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: H2,
				runner_files: { 'box-runner.mjs': H1 },
			}),
		).toBeNull()
	})
})

describe('runnerFetchScript', () => {
	it('verifies every file before installing any', () => {
		const script = runnerFetchScript({
			ref: REF,
			files: { 'box-runner.mjs': H1, 'harness/claude.mjs': H2 },
		})
		expect(script).toContain(`'${runnerUrl(REF, 'harness/claude.mjs')}'`)
		expect(script).toContain(`'${runnerUrl(REF)}'`)
		expect(script).toContain(`${H1}  box-runner.mjs`)
		expect(script).toContain(`${H2}  harness/claude.mjs`)
		const verify = script.indexOf('sha256sum -c')
		expect(verify).toBeGreaterThan(script.lastIndexOf('curl '))
		expect(verify).toBeLessThan(script.indexOf("mv '"))
	})

	it('throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/a.mjs': H1 } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': H1, '../x': H2 } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: 'main', files: { 'box-runner.mjs': H1 } })).toThrow()
	})

	it('bootstrapUserData fetches every manifest file before the box token', () => {
		const ud = bootstrapUserData({
			boxId: 'box-1',
			agentId: 'ca_1',
			queue: 'agent:ca_1',
			route: 'claude',
			ttlSeconds: 600,
			mcpBaseUrl: null,
			boxToken: 'box-1.secret',
			claudeModel: null,
			runnerPin: { ref: REF, files: { 'box-runner.mjs': H1, 'lib/q.mjs': H2 } },
		})
		expect(ud).toContain(runnerUrl(REF, 'lib/q.mjs'))
		expect(ud.indexOf('FERMI_BOX_TOKEN')).toBeGreaterThan(ud.indexOf('sha256sum -c'))
	})
})

describe('pinRunner', () => {
	const RAW = 'https://raw.githubusercontent.com'
	const base = `/abel30567/fermi-daemon/${REF}`
	beforeEach(async () => {
		await env.FERMI_KV.delete('fleet:config')
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	afterEach(() => fetchMock.deactivate())

	const serve = (path: string, body: string) =>
		fetchMock
			.get(RAW)
			.intercept({ path: `${base}/${path}`, method: 'GET' })
			.reply(200, body)

	it('rejects a bad ref or malformed files with 400', async () => {
		expect((await pinRunner(env, { ref: 'main' })).status).toBe(400)
		expect((await pinRunner(env, {})).status).toBe(400)
		for (const files of [
			'box-runner.mjs',
			42,
			[],
			['../x'],
			{},
			{ 'lib/a.mjs': H1 },
			{ 'box-runner.mjs': 'nothex' },
			{ 'box-runner.mjs': H1, '/abs': H2 },
		]) {
			expect((await pinRunner(env, { ref: REF, files })).status).toBe(400)
		}
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('legacy single-file pin still works', async () => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ instance_type: 't3.medium' }))
		serve('box-runner.mjs', 'runner')
		const res = await pinRunner(env, { ref: REF })
		expect(res).toMatchObject({ status: 200, body: { ok: true, sha256: await sha('runner') } })
		const config = await getFleetConfig(env)
		expect(config).toMatchObject({
			instance_type: 't3.medium',
			runner_ref: REF,
			runner_sha256: await sha('runner'),
			runner_files: null,
		})
		expect(runnerPinFromConfig(config)).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': await sha('runner') },
		})
	})

	it('pins a manifest given as paths (box-runner.mjs always included)', async () => {
		serve('box-runner.mjs', 'runner')
		serve('harness/claude.mjs', 'claude')
		const res = await pinRunner(env, { ref: REF, files: ['harness/claude.mjs'] })
		expect(res.status).toBe(200)
		const files = {
			'box-runner.mjs': await sha('runner'),
			'harness/claude.mjs': await sha('claude'),
		}
		const config = await getFleetConfig(env)
		expect(config.runner_files).toEqual(files)
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files })
	})

	it('pins a {path: sha256} manifest only when every fetched file matches', async () => {
		serve('box-runner.mjs', 'runner')
		serve('lib/q.mjs', 'tampered')
		const mismatch = await pinRunner(env, {
			ref: REF,
			files: { 'box-runner.mjs': await sha('runner'), 'lib/q.mjs': await sha('q') },
		})
		expect(mismatch).toMatchObject({
			status: 409,
			body: { error: 'sha256_mismatch', path: 'lib/q.mjs' },
		})
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()

		serve('box-runner.mjs', 'runner')
		serve('lib/q.mjs', 'q')
		const files = { 'box-runner.mjs': await sha('runner'), 'lib/q.mjs': await sha('q') }
		expect((await pinRunner(env, { ref: REF, files })).status).toBe(200)
		expect(runnerPinFromConfig(await getFleetConfig(env))).toEqual({ ref: REF, files })
	})

	it('a missing file fails the pin without storing it', async () => {
		serve('box-runner.mjs', 'runner')
		fetchMock
			.get(RAW)
			.intercept({ path: `${base}/lib/q.mjs`, method: 'GET' })
			.reply(404, '')
		const res = await pinRunner(env, { ref: REF, files: ['lib/q.mjs'] })
		expect(res).toMatchObject({ status: 502, body: { error: 'fetch_404', path: 'lib/q.mjs' } })
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})
})
