import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import { bootstrapUserData } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'

// Boot-time tamper/omit behaviour is exercised for real by test/shell/boot-pin-harness.sh.

const REF = 'a'.repeat(40)
const H1 = '1'.repeat(64)
const H2 = '2'.repeat(64)
const RAW = 'https://raw.githubusercontent.com'
const DIR = `/abel30567/fermi-daemon/${REF}`

async function sha256(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('runnerPinFromConfig', () => {
	it('reads a legacy single-file pin as a one-entry manifest', () => {
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
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: files })).toEqual({
			ref: REF,
			files,
		})
	})

	it('returns null when unset or invalid', () => {
		const bad = [
			{},
			{ runner_ref: REF, runner_sha256: null },
			{ runner_ref: null, runner_sha256: H1 },
			{ runner_ref: "x'; rm -rf /", runner_sha256: H1 },
			{ runner_ref: REF, runner_sha256: 'nothex' },
			{ runner_ref: REF, runner_files: { 'lib/util.mjs': H1 } },
			{ runner_ref: REF, runner_files: {} },
			{ runner_ref: REF, runner_files: ['box-runner.mjs'] },
			{ runner_ref: REF, runner_files: { 'box-runner.mjs': H1, '../evil.mjs': H2 } },
			{ runner_ref: REF, runner_files: { 'box-runner.mjs': H1, '/etc/passwd': H2 } },
			{ runner_ref: REF, runner_files: { 'box-runner.mjs': H1, "a'b.mjs": H2 } },
			{ runner_ref: REF, runner_files: { 'box-runner.mjs': H1, 'lib//x.mjs': H2 } },
			{ runner_ref: REF, runner_files: { 'box-runner.mjs': 'short' } },
			// Entry hash disagrees with the legacy field: fail closed.
			{ runner_ref: REF, runner_sha256: H2, runner_files: { 'box-runner.mjs': H1 } },
		]
		for (const config of bad) expect(runnerPinFromConfig(config), JSON.stringify(config)).toBeNull()
	})
})

describe('runnerFetchScript / runnerUrl', () => {
	it('fetches and verifies every file into the same layout', () => {
		const script = runnerFetchScript({
			ref: REF,
			files: { 'box-runner.mjs': H1, 'harness/claude.mjs': H2 },
		})
		expect(script).toContain(`${RAW}${DIR}/box-runner.mjs`)
		expect(script).toContain(`${RAW}${DIR}/harness/claude.mjs`)
		expect(script).toContain(
			`echo '${H1}  /opt/fermi/.runner-staging/box-runner.mjs' | sha256sum -c -`,
		)
		expect(script).toContain(
			`echo '${H2}  /opt/fermi/.runner-staging/harness/claude.mjs' | sha256sum -c -`,
		)
		expect(script).toContain(
			"mv '/opt/fermi/.runner-staging/harness/claude.mjs' '/opt/fermi/harness/claude.mjs'",
		)
		// Every hash check precedes the first install.
		const lines = script.split('\n')
		const lastCheck = lines.findLastIndex((l) => l.includes('sha256sum -c'))
		const firstMv = lines.findIndex((l) => l.startsWith('mv '))
		expect(lastCheck).toBeLessThan(firstMv)
	})

	it('throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/x.mjs': H1 } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': H1, '../x.mjs': H2 } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: 'main', files: { 'box-runner.mjs': H1 } })).toThrow()
	})

	it('defaults the path to box-runner.mjs', () => {
		expect(runnerUrl(REF)).toBe(`${RAW}${DIR}/box-runner.mjs`)
		expect(runnerUrl(REF, 'lib/x.mjs')).toBe(`${RAW}${DIR}/lib/x.mjs`)
	})

	it('bootstrapUserData verifies every manifest file before the box token lands', () => {
		const userData = bootstrapUserData({
			boxId: 'box-1',
			agentId: 'ca_1',
			queue: 'agent:ca_1',
			route: 'claude',
			ttlSeconds: 600,
			mcpBaseUrl: null,
			boxToken: 'box-1.secret',
			claudeModel: null,
			runnerPin: { ref: REF, files: { 'box-runner.mjs': H1, 'lib/util.mjs': H2 } },
		})
		const token = userData.indexOf('FERMI_BOX_TOKEN=')
		expect(userData.indexOf(`${RAW}${DIR}/lib/util.mjs`)).toBeGreaterThan(0)
		expect(userData.lastIndexOf('sha256sum -c')).toBeLessThan(token)
	})
})

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	beforeEach(async () => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ instance_type: 't3.medium' }))
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})
	const stored = async () => JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
	const serve = (path: string, body: string, status = 200) =>
		fetchMock
			.get(RAW)
			.intercept({ path: `${DIR}/${path}`, method: 'GET' })
			.reply(status, body)

	it('legacy single-file pin: hashes box-runner.mjs and clears any manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ runner_files: { 'box-runner.mjs': H1, 'lib/x.mjs': H2 } }),
		)
		serve('box-runner.mjs', 'runner')
		const res = await pinRunner(env, { ref: REF })
		const sha = await sha256('runner')
		expect(res).toMatchObject({ status: 200, body: { ok: true, ref: REF, sha256: sha } })
		const config = await stored()
		expect(config).toMatchObject({ runner_ref: REF, runner_sha256: sha, runner_files: null })
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files: { 'box-runner.mjs': sha } })
	})

	it('manifest: fetches every file, checks each hash, stores the manifest', async () => {
		const files = {
			'box-runner.mjs': await sha256('runner'),
			'harness/claude.mjs': await sha256('claude'),
		}
		serve('box-runner.mjs', 'runner')
		serve('harness/claude.mjs', 'claude')
		const res = await pinRunner(env, { ref: REF, files })
		expect(res).toMatchObject({ status: 200, body: { ok: true, files } })
		const config = await stored()
		expect(config).toMatchObject({
			instance_type: 't3.medium',
			runner_ref: REF,
			runner_sha256: files['box-runner.mjs'],
			runner_files: files,
		})
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files })
	})

	it('rejects a manifest whose declared hash does not match the ref', async () => {
		serve('box-runner.mjs', 'runner')
		serve('lib/util.mjs', 'tampered')
		const files = { 'box-runner.mjs': await sha256('runner'), 'lib/util.mjs': await sha256('util') }
		const res = await pinRunner(env, { ref: REF, files })
		expect(res).toMatchObject({
			status: 409,
			body: { error: 'sha256_mismatch', path: 'lib/util.mjs' },
		})
		expect(await stored()).toEqual({ instance_type: 't3.medium' })
	})

	it('reports a missing file as 502 without storing', async () => {
		serve('box-runner.mjs', 'runner')
		serve('lib/util.mjs', 'nope', 404)
		const files = { 'box-runner.mjs': await sha256('runner'), 'lib/util.mjs': H1 }
		const res = await pinRunner(env, { ref: REF, files })
		expect(res).toMatchObject({ status: 502, body: { error: 'fetch_404', path: 'lib/util.mjs' } })
		expect(await stored()).toEqual({ instance_type: 't3.medium' })
	})

	it('returns 400 on a bad ref or malformed files, without fetching', async () => {
		const bad = [
			{ ref: 'main' },
			{},
			{ ref: REF, files: ['box-runner.mjs'] },
			{ ref: REF, files: { 'lib/x.mjs': H1 } },
			{ ref: REF, files: { 'box-runner.mjs': H1, '../x.mjs': H2 } },
			{ ref: REF, files: { 'box-runner.mjs': 'nothex' } },
			{ ref: REF, files: null },
		]
		for (const body of bad) {
			const res = await pinRunner(env, body)
			expect(res.status, JSON.stringify(body)).toBe(400)
		}
		expect(await stored()).toEqual({ instance_type: 't3.medium' })
	})
})
