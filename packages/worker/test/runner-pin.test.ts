import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import { bootstrapUserData } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'

const REF = '0123456789abcdef0123456789abcdef01234567'
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const GH = 'https://raw.githubusercontent.com'
const PATH = (p: string) => `/abel30567/fermi-daemon/${REF}/${p}`

async function sha256(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('runnerPinFromConfig', () => {
	it('maps a legacy single-file pin to a box-runner.mjs manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: A })).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': A },
		})
	})

	it('prefers runner_files when set', () => {
		const files = { 'box-runner.mjs': A, 'harness/index.mjs': B }
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: A, runner_files: files })).toEqual(
			{ ref: REF, files },
		)
	})

	it('returns null when unset or invalid', () => {
		expect(runnerPinFromConfig({})).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: 'main', runner_sha256: A })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'xyz' })).toBeNull()
		// manifest without the entry point
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: { 'lib/a.mjs': A } })).toBeNull()
		for (const bad of ['../evil.mjs', '/etc/passwd', 'lib/../x', "a'b.mjs", 'a b', 'lib//x', '']) {
			expect(
				runnerPinFromConfig({ runner_ref: REF, runner_files: { 'box-runner.mjs': A, [bad]: B } }),
				bad,
			).toBeNull()
		}
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_files: { 'box-runner.mjs': 'nothex' } }),
		).toBeNull()
	})
})

describe('runnerFetchScript / runnerUrl', () => {
	it('builds per-path raw URLs', () => {
		expect(runnerUrl(REF)).toBe(`${GH}${PATH('box-runner.mjs')}`)
		expect(runnerUrl(REF, 'lib/x.mjs')).toBe(`${GH}${PATH('lib/x.mjs')}`)
	})

	it('fetches, verifies and installs every manifest file', () => {
		const s = runnerFetchScript({
			ref: REF,
			files: { 'box-runner.mjs': A, 'harness/index.mjs': B },
		})
		expect(s).toContain(`'${GH}${PATH('box-runner.mjs')}'`)
		expect(s).toContain(`'${GH}${PATH('harness/index.mjs')}'`)
		expect(s).toContain(`${A}  box-runner.mjs`)
		expect(s).toContain(`${B}  harness/index.mjs`)
		expect(s).toContain('sha256sum -c --strict')
		expect(s).toContain("'/opt/fermi/harness/index.mjs'")
		expect(s).toContain('--retry 4')
		// verification precedes every install
		expect(s.indexOf('sha256sum')).toBeLessThan(s.indexOf('mv '))
	})

	it('throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/a.mjs': A } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': A, '../x': B } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: 'nope', files: { 'box-runner.mjs': A } })).toThrow()
	})

	it('bootstrapUserData verifies all files before credentials land', () => {
		const ud = bootstrapUserData({
			boxId: 'box-1',
			agentId: 'ca_1',
			queue: 'q',
			route: 'claude',
			ttlSeconds: 60,
			mcpBaseUrl: null,
			boxToken: 'box-1.secret',
			claudeModel: null,
			runnerPin: { ref: REF, files: { 'box-runner.mjs': A, 'lib/x.mjs': B } },
		})
		expect(ud).toContain(`${B}  lib/x.mjs`)
		expect(ud.indexOf('sha256sum')).toBeLessThan(ud.indexOf('FERMI_BOX_TOKEN'))
	})
})

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	beforeEach(async () => {
		await env.FERMI_KV.delete('fleet:config')
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	const serve = (p: string, body: string) =>
		fetchMock
			.get(GH)
			.intercept({ path: PATH(p), method: 'GET' })
			.reply(200, body)

	it('legacy single-file pin still works and still boots', async () => {
		serve('box-runner.mjs', 'runner')
		const out = await pinRunner(env, { ref: REF })
		const sha = await sha256('runner')
		expect(out).toMatchObject({ status: 200, body: { ok: true, sha256: sha } })
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(stored).toMatchObject({ runner_ref: REF, runner_sha256: sha, runner_files: null })
		expect(runnerPinFromConfig(stored)).toEqual({ ref: REF, files: { 'box-runner.mjs': sha } })
	})

	it('pins a list of paths, hashing each', async () => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ region: 'us-west-2' }))
		serve('box-runner.mjs', 'runner')
		serve('harness/index.mjs', 'harness')
		const out = await pinRunner(env, { ref: REF, files: ['harness/index.mjs'] })
		expect(out.status).toBe(200)
		const files = {
			'box-runner.mjs': await sha256('runner'),
			'harness/index.mjs': await sha256('harness'),
		}
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
		expect(stored).toMatchObject({ region: 'us-west-2', runner_ref: REF, runner_files: files })
		expect(runnerPinFromConfig(stored)).toEqual({ ref: REF, files })
	})

	it('accepts a {path: sha256} manifest when hashes match, 409 when not', async () => {
		serve('box-runner.mjs', 'runner')
		serve('lib/x.mjs', 'x')
		const files = { 'box-runner.mjs': await sha256('runner'), 'lib/x.mjs': await sha256('x') }
		expect((await pinRunner(env, { ref: REF, files })).status).toBe(200)

		serve('box-runner.mjs', 'runner')
		serve('lib/x.mjs', 'tampered')
		await env.FERMI_KV.delete('fleet:config')
		const out = await pinRunner(env, { ref: REF, files })
		expect(out).toMatchObject({
			status: 409,
			body: { error: 'sha256_mismatch', path: 'lib/x.mjs' },
		})
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('400 on a bad ref or malformed files, without fetching', async () => {
		for (const body of [
			{},
			{ ref: 'main' },
			{ ref: REF, files: 'box-runner.mjs' },
			{ ref: REF, files: ['../etc/passwd'] },
			{ ref: REF, files: [42] },
			{ ref: REF, files: { 'lib/x.mjs': A } },
			{ ref: REF, files: { 'box-runner.mjs': 'short' } },
			{ ref: REF, files: { 'box-runner.mjs': A, '/abs.mjs': B } },
		]) {
			expect((await pinRunner(env, body)).status, JSON.stringify(body)).toBe(400)
		}
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('502 when a manifest file is missing upstream', async () => {
		serve('box-runner.mjs', 'runner')
		fetchMock
			.get(GH)
			.intercept({ path: PATH('lib/x.mjs'), method: 'GET' })
			.reply(404, '')
		const out = await pinRunner(env, { ref: REF, files: ['lib/x.mjs'] })
		expect(out).toMatchObject({ status: 502, body: { error: 'fetch_404', path: 'lib/x.mjs' } })
	})
})
