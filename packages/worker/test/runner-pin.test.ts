import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getFleetConfig, pinRunner } from '../src/lib/fleet-config.ts'
import { bootstrapUserData } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'

const REF = 'a'.repeat(40)
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)

async function sha256(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('runnerPinFromConfig (pr-55)', () => {
	it('maps a legacy single-file pin to a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_A })).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': SHA_A },
		})
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA_A, runner_files: null }),
		).toEqual({ ref: REF, files: { 'box-runner.mjs': SHA_A } })
	})

	it('returns the manifest when runner_files is set', () => {
		const files = { 'box-runner.mjs': SHA_A, 'harness/claude.mjs': SHA_B, 'lib/util.mjs': SHA_C }
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
		expect(runnerPinFromConfig({ runner_ref: REF })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: SHA_A })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: 'main', runner_sha256: SHA_A })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'nothex' })).toBeNull()
		// manifest without the entry point
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_files: { 'lib/util.mjs': SHA_C } }),
		).toBeNull()
		// unsafe paths
		for (const bad of ['../x.mjs', '/etc/passwd', 'lib//x', 'lib/./x', "a'b", 'a b', '']) {
			expect(
				runnerPinFromConfig({
					runner_ref: REF,
					runner_files: { 'box-runner.mjs': SHA_A, [bad]: SHA_B },
				}),
			).toBeNull()
		}
		// malformed hash / shape
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_files: { 'box-runner.mjs': SHA_A, 'lib/x.mjs': 'zz' },
			}),
		).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: ['box-runner.mjs'] })).toBeNull()
		// entry hash disagreeing with runner_sha256
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: SHA_B,
				runner_files: { 'box-runner.mjs': SHA_A },
			}),
		).toBeNull()
	})
})

describe('runnerFetchScript / runnerUrl (pr-55)', () => {
	it('builds per-path raw URLs, defaulting to box-runner.mjs', () => {
		expect(runnerUrl(REF)).toBe(
			`https://raw.githubusercontent.com/abel30567/fermi-daemon/${REF}/box-runner.mjs`,
		)
		expect(runnerUrl(REF, 'harness/claude.mjs')).toBe(
			`https://raw.githubusercontent.com/abel30567/fermi-daemon/${REF}/harness/claude.mjs`,
		)
	})

	it('fetches and verifies every file before installing any', () => {
		const s = runnerFetchScript({
			ref: REF,
			files: { 'lib/util.mjs': SHA_C, 'box-runner.mjs': SHA_A, 'harness/claude.mjs': SHA_B },
		})
		for (const [p, h] of [
			['box-runner.mjs', SHA_A],
			['harness/claude.mjs', SHA_B],
			['lib/util.mjs', SHA_C],
		]) {
			expect(s).toContain(`'${runnerUrl(REF, p)}' -o '/opt/fermi/.runner.new/${p}'`)
			expect(s).toContain(`echo '${h}  /opt/fermi/.runner.new/${p}' | sha256sum -c -`)
			expect(s).toContain(`mv '/opt/fermi/.runner.new/${p}' '/opt/fermi/${p}'`)
		}
		const lines = s.split('\n')
		const lastCheck = lines.findLastIndex((l) => l.includes('sha256sum -c'))
		const firstMv = lines.findIndex((l) => l.startsWith('mv '))
		expect(lastCheck).toBeLessThan(firstMv)
	})

	it('throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/util.mjs': SHA_C } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': SHA_A, '../x': SHA_B } }),
		).toThrow()
		expect(() =>
			runnerFetchScript({ ref: "x'; rm -rf /", files: { 'box-runner.mjs': SHA_A } }),
		).toThrow()
	})

	it('bootstrapUserData verifies the whole manifest before writing the box token', () => {
		const ud = bootstrapUserData({
			boxId: 'box-1',
			agentId: 'ca_1',
			queue: 'agent:ca_1',
			route: 'claude',
			ttlSeconds: 600,
			mcpBaseUrl: null,
			boxToken: 'box-1.secret',
			claudeModel: null,
			runnerPin: { ref: REF, files: { 'box-runner.mjs': SHA_A, 'harness/claude.mjs': SHA_B } },
		})
		const tokenAt = ud.indexOf('FERMI_BOX_TOKEN=')
		expect(ud.indexOf(`${SHA_B}  /opt/fermi/.runner.new/harness/claude.mjs`)).toBeGreaterThan(0)
		expect(ud.lastIndexOf('sha256sum -c')).toBeLessThan(tokenAt)
	})
})

describe('pinRunner (pr-55)', () => {
	const ORIGIN = 'https://raw.githubusercontent.com'
	const path = (p: string) => `/abel30567/fermi-daemon/${REF}/${p}`
	const SRC: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")\n',
		'harness/claude.mjs': 'export const route = "claude"\n',
		'lib/util.mjs': 'export const util = 1\n',
	}
	const serve = (p: string, status = 200) =>
		fetchMock
			.get(ORIGIN)
			.intercept({ path: path(p) })
			.reply(status, status === 200 ? SRC[p] : 'nope')
	const manifest = async () =>
		Object.fromEntries(
			await Promise.all(Object.entries(SRC).map(async ([p, c]) => [p, await sha256(c)])),
		) as Record<string, string>

	beforeEach(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ instance_type: 't3.medium' }))
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	it('legacy { ref } still fetches and pins box-runner.mjs', async () => {
		serve('box-runner.mjs')
		const res = await pinRunner(env, { ref: REF })
		const sha = await sha256(SRC['box-runner.mjs'])
		expect(res).toMatchObject({ status: 200, body: { ok: true, ref: REF, sha256: sha } })
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(stored).toMatchObject({
			instance_type: 't3.medium',
			runner_ref: REF,
			runner_sha256: sha,
			runner_files: null,
		})
		expect(runnerPinFromConfig(await getFleetConfig(env))).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': sha },
		})
	})

	it('a manifest pin verifies every file and stores the manifest', async () => {
		for (const p of Object.keys(SRC)) serve(p)
		const files = await manifest()
		const res = await pinRunner(env, { ref: REF, files })
		expect(res).toMatchObject({ status: 200, body: { ok: true, files } })
		const config = await getFleetConfig(env)
		expect(config).toMatchObject({
			runner_ref: REF,
			runner_sha256: files['box-runner.mjs'],
			runner_files: files,
		})
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files })
	})

	it('re-pinning legacy clears a previous manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ runner_ref: REF, runner_files: { 'box-runner.mjs': SHA_A } }),
		)
		serve('box-runner.mjs')
		expect((await pinRunner(env, { ref: REF })).status).toBe(200)
		expect((await getFleetConfig(env)).runner_files).toBeNull()
	})

	it('400s on a bad ref or malformed files without fetching or storing', async () => {
		const before = await env.FERMI_KV.get('fleet:config')
		for (const body of [
			{},
			{ ref: 'main' },
			{ ref: REF, files: [] },
			{ ref: REF, files: 'box-runner.mjs' },
			{ ref: REF, files: { 'lib/util.mjs': SHA_C } },
			{ ref: REF, files: { 'box-runner.mjs': SHA_A, '../x.mjs': SHA_B } },
			{ ref: REF, files: { 'box-runner.mjs': 'short' } },
		]) {
			const res = await pinRunner(env, body)
			expect(res.status, JSON.stringify(body)).toBe(400)
			expect(res.body.ok).toBe(false)
		}
		expect(await env.FERMI_KV.get('fleet:config')).toBe(before)
	})

	it('refuses a manifest whose fetched file does not match, storing nothing', async () => {
		const before = await env.FERMI_KV.get('fleet:config')
		for (const p of Object.keys(SRC)) serve(p)
		const files = { ...(await manifest()), 'lib/util.mjs': SHA_C }
		const res = await pinRunner(env, { ref: REF, files })
		expect(res).toMatchObject({
			status: 400,
			body: { error: 'sha256_mismatch', path: 'lib/util.mjs' },
		})
		expect(await env.FERMI_KV.get('fleet:config')).toBe(before)
	})

	it('502s when a manifest file is missing at the ref', async () => {
		serve('box-runner.mjs')
		serve('harness/claude.mjs', 404)
		const { 'lib/util.mjs': _omitted, ...files } = await manifest()
		const res = await pinRunner(env, { ref: REF, files })
		expect(res).toMatchObject({
			status: 502,
			body: { error: 'fetch_404', path: 'harness/claude.mjs' },
		})
	})
})
