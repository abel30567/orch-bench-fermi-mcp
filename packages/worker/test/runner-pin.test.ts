import { env, fetchMock } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getFleetConfig, pinRunner } from '../src/lib/fleet-config.ts'
import { bootstrapUserData } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'

const REF = 'a'.repeat(40)
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const RAW = 'https://raw.githubusercontent.com'

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function serve(path: string, body: string, status = 200) {
	fetchMock
		.get(RAW)
		.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}` })
		.reply(status, body)
}

describe('runnerPinFromConfig', () => {
	it('maps a legacy single-file pin to a one-entry manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_A })).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': SHA_A },
		})
	})

	it('reads a manifest pin', () => {
		const files = { 'box-runner.mjs': SHA_A, 'harness/claude.mjs': SHA_B }
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_A, runner_files: files }),
		).toEqual({ ref: REF, files })
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: files })).toEqual({
			ref: REF,
			files,
		})
	})

	it('returns null when unset or invalid', () => {
		expect(runnerPinFromConfig({})).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: SHA_A })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: "x'; rm -rf /", runner_sha256: SHA_A })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: '..', runner_sha256: SHA_A })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'nothex' })).toBeNull()
		// Manifest without box-runner.mjs.
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_files: { 'lib/a.mjs': SHA_A } }),
		).toBeNull()
		// Unsafe paths.
		for (const bad of ['../x.mjs', '/etc/passwd', 'lib/../x', 'lib//x', '.hidden', "a'b", 'a b']) {
			expect(
				runnerPinFromConfig({
					runner_ref: REF,
					runner_files: { 'box-runner.mjs': SHA_A, [bad]: SHA_B },
				}),
			).toBeNull()
		}
		// Manifest and legacy hash disagree on the entrypoint.
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: SHA_B,
				runner_files: { 'box-runner.mjs': SHA_A },
			}),
		).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: [] })).toBeNull()
	})
})

describe('runnerFetchScript', () => {
	it('fetches every file to staging, verifies all hashes, then installs', () => {
		const script = runnerFetchScript({
			ref: REF,
			files: { 'box-runner.mjs': SHA_A, 'harness/claude.mjs': SHA_B },
		})
		expect(script).toContain(
			`'${runnerUrl(REF, 'harness/claude.mjs')}' -o '/opt/fermi.runner-new/harness/claude.mjs'`,
		)
		expect(script).toContain(`'${runnerUrl(REF)}' -o '/opt/fermi.runner-new/box-runner.mjs'`)
		expect(script).toContain(`${SHA_A}  /opt/fermi.runner-new/box-runner.mjs`)
		expect(script).toContain(`${SHA_B}  /opt/fermi.runner-new/harness/claude.mjs`)
		// Nothing is moved into /opt/fermi until the single sha256sum gate passed.
		const check = script.indexOf('sha256sum -c')
		expect(script.indexOf("mv '/opt/fermi.runner-new/")).toBeGreaterThan(check)
		expect(script.lastIndexOf('curl ')).toBeLessThan(check)
	})

	it('throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/a.mjs': SHA_A } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': SHA_A, '../x': SHA_B } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: "'", files: { 'box-runner.mjs': SHA_A } })).toThrow()
	})

	it('runnerUrl defaults to box-runner.mjs', () => {
		expect(runnerUrl(REF)).toBe(`${RAW}/abel30567/fermi-daemon/${REF}/box-runner.mjs`)
		expect(runnerUrl(REF, 'lib/a.mjs')).toBe(`${RAW}/abel30567/fermi-daemon/${REF}/lib/a.mjs`)
	})

	it('bootstrapUserData verifies every pinned file before the box token is written', () => {
		const userData = bootstrapUserData({
			boxId: 'box-1',
			agentId: 'ca_1',
			queue: 'agent:ca_1',
			route: 'claude',
			ttlSeconds: 600,
			mcpBaseUrl: null,
			boxToken: 'box-1.secret',
			claudeModel: null,
			runnerPin: { ref: REF, files: { 'box-runner.mjs': SHA_A, 'lib/q.mjs': SHA_B } },
		})
		const check = userData.indexOf('sha256sum -c')
		expect(userData).toContain(`${SHA_B}  /opt/fermi.runner-new/lib/q.mjs`)
		expect(userData.indexOf('FERMI_BOX_TOKEN=')).toBeGreaterThan(check)
	})
})

describe('pinRunner', () => {
	beforeAll(() => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	beforeEach(async () => {
		await env.FERMI_KV.delete('fleet:config')
	})

	it('rejects a bad ref or malformed files with 400', async () => {
		expect((await pinRunner(env, { ref: 'main' })).status).toBe(400)
		expect((await pinRunner(env, {})).status).toBe(400)
		for (const files of [
			[],
			'x',
			{ 'lib/a.mjs': SHA_A },
			{ 'box-runner.mjs': 'nothex' },
			{ 'box-runner.mjs': SHA_A, '../a': SHA_B },
		]) {
			expect((await pinRunner(env, { ref: REF, files })).status).toBe(400)
		}
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('legacy {ref} hashes box-runner.mjs and keeps the single-file shape', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ region: 'eu-west-1', runner_files: { x: 1 } }),
		)
		serve('box-runner.mjs', 'runner v1')
		const res = await pinRunner(env, { ref: REF })
		const sha = await sha256('runner v1')
		expect(res).toEqual({ status: 200, body: { ok: true, ref: REF, sha256: sha, bytes: 9 } })
		const config = await getFleetConfig(env)
		expect(config).toMatchObject({
			region: 'eu-west-1',
			runner_ref: REF,
			runner_sha256: sha,
			runner_files: null,
		})
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files: { 'box-runner.mjs': sha } })
	})

	it('manifest pin verifies every file and stores the manifest', async () => {
		serve('box-runner.mjs', 'runner v2')
		serve('harness/claude.mjs', 'harness v2')
		const files = {
			'box-runner.mjs': await sha256('runner v2'),
			'harness/claude.mjs': await sha256('harness v2'),
		}
		const res = await pinRunner(env, { ref: REF, files })
		expect(res.status).toBe(200)
		expect(res.body).toMatchObject({ ok: true, ref: REF, sha256: files['box-runner.mjs'], files })
		const config = await getFleetConfig(env)
		expect(config).toMatchObject({
			runner_ref: REF,
			runner_sha256: files['box-runner.mjs'],
			runner_files: files,
		})
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files })
	})

	it('refuses a manifest whose hash does not match the fetched file', async () => {
		serve('box-runner.mjs', 'runner v3')
		serve('lib/q.mjs', 'tampered')
		const files = {
			'box-runner.mjs': await sha256('runner v3'),
			'lib/q.mjs': await sha256('queue v3'),
		}
		const res = await pinRunner(env, { ref: REF, files })
		expect(res.status).toBe(409)
		expect(res.body).toMatchObject({ ok: false, error: 'sha256_mismatch', path: 'lib/q.mjs' })
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('reports a missing manifest file as 502', async () => {
		serve('box-runner.mjs', 'runner v4')
		serve('lib/gone.mjs', 'not found', 404)
		const files = { 'box-runner.mjs': await sha256('runner v4'), 'lib/gone.mjs': SHA_A }
		const res = await pinRunner(env, { ref: REF, files })
		expect(res).toMatchObject({
			status: 502,
			body: { ok: false, error: 'fetch_404', path: 'lib/gone.mjs' },
		})
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})
})
