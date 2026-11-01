import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getFleetConfig, pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const PIN = { ref: 'a'.repeat(40), files: { 'box-runner.mjs': 'b'.repeat(64) } }
const MANIFEST = {
	ref: 'a'.repeat(40),
	files: {
		'box-runner.mjs': 'b'.repeat(64),
		'lib/log.mjs': 'c'.repeat(64),
		'harness/claude.mjs': 'd'.repeat(64),
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

	it('fetch script fetches and verifies every manifest file before installing any', () => {
		const script = runnerFetchScript(MANIFEST)
		const firstMv = script.indexOf('\nmv ')
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(runnerUrl(MANIFEST.ref, path))
			const verifyAt = script.indexOf(`echo '${sha}  /opt/fermi/.runner-stage/${path}'`)
			expect(verifyAt).toBeGreaterThan(-1)
			expect(verifyAt).toBeLessThan(firstMv)
			expect(script).toContain(`mv '/opt/fermi/.runner-stage/${path}' '/opt/fermi/${path}'`)
		}
	})

	it('user-data verifies every manifest file BEFORE materializing the box token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const sha of Object.values(MANIFEST.files)) {
			const at = script.indexOf(sha)
			expect(at).toBeGreaterThan(-1)
			expect(at).toBeLessThan(tokenAt)
		}
	})

	it('fetch script throws on an invalid manifest', () => {
		const sha = 'e'.repeat(64)
		expect(() => runnerFetchScript({ ref: PIN.ref, files: { 'lib/x.mjs': sha } })).toThrow()
		for (const bad of ['../evil.mjs', '/etc/passwd', 'lib/../x', "a'b.mjs", '.hidden', 'a//b']) {
			expect(() =>
				runnerFetchScript({ ref: PIN.ref, files: { 'box-runner.mjs': sha, [bad]: sha } }),
			).toThrow()
		}
		expect(() =>
			runnerFetchScript({ ref: PIN.ref, files: { 'box-runner.mjs': 'nothex' } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: "x'; rm -rf /", files: PIN.files })).toThrow()
	})

	describe('runnerPinFromConfig', () => {
		const sha = 'b'.repeat(64)
		it('maps a legacy single-file pin onto a one-file manifest', () => {
			expect(runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: sha })).toEqual({
				ref: 'v1',
				files: { 'box-runner.mjs': sha },
			})
			expect(
				runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: sha, runner_files: null }),
			).toEqual({ ref: 'v1', files: { 'box-runner.mjs': sha } })
		})
		it('returns the manifest when runner_files is set', () => {
			expect(
				runnerPinFromConfig({
					runner_ref: MANIFEST.ref,
					runner_sha256: sha,
					runner_files: MANIFEST.files,
				}),
			).toEqual(MANIFEST)
		})
		it('returns null when unset or invalid', () => {
			expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
			expect(runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: null })).toBeNull()
			expect(runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: 'short' })).toBeNull()
			expect(runnerPinFromConfig({ runner_ref: null, runner_files: MANIFEST.files })).toBeNull()
			expect(
				runnerPinFromConfig({ runner_ref: 'v1', runner_files: { 'lib/x.mjs': sha } }),
			).toBeNull()
			expect(
				runnerPinFromConfig({
					runner_ref: 'v1',
					runner_files: { 'box-runner.mjs': sha, '../x.mjs': sha },
				}),
			).toBeNull()
			expect(runnerPinFromConfig({ runner_ref: 'v1', runner_files: {} })).toBeNull()
		})
	})

	describe('pinRunner', () => {
		const REF = 'f'.repeat(40)
		const BODIES: Record<string, string> = {
			'box-runner.mjs': 'console.log("runner")',
			'lib/log.mjs': 'export const log = 1',
			'harness/claude.mjs': 'export const h = 1',
		}
		async function hex(s: string) {
			const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
			return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
		}
		function serve(paths: string[]) {
			fetchMock.activate()
			fetchMock.disableNetConnect()
			for (const p of paths) {
				fetchMock
					.get('https://raw.githubusercontent.com')
					.intercept({ path: `/abel30567/fermi-daemon/${REF}/${p}` })
					.reply(200, BODIES[p])
			}
		}
		afterEach(() => fetchMock.deactivate())

		it('400s on a bad ref or malformed files', async () => {
			await env.FERMI_KV.put('fleet:config', JSON.stringify({ default_env: 'x' }))
			const sha = 'b'.repeat(64)
			for (const body of [
				{},
				{ ref: 'main' },
				{ ref: REF, files: 'box-runner.mjs' },
				{ ref: REF, files: 42 },
				{ ref: REF, files: ['../evil.mjs'] },
				{ ref: REF, files: [1] },
				{ ref: REF, files: { 'lib/x.mjs': sha } },
				{ ref: REF, files: { 'box-runner.mjs': 'nothex' } },
				{ ref: REF, files: { 'box-runner.mjs': sha, '/etc/passwd': sha } },
			]) {
				const out = await pinRunner(env, body)
				expect(out.status, JSON.stringify(body)).toBe(400)
			}
			expect(await env.FERMI_KV.get('fleet:config')).toBe(JSON.stringify({ default_env: 'x' }))
		})

		it('legacy single-file pin hashes box-runner.mjs and still boots', async () => {
			await env.FERMI_KV.put('fleet:config', JSON.stringify({ default_env: 'keep' }))
			serve(['box-runner.mjs'])
			const out = await pinRunner(env, { ref: REF })
			expect(out.status).toBe(200)
			const sha = await hex(BODIES['box-runner.mjs'])
			expect(out.body.sha256).toBe(sha)
			const config = await getFleetConfig(env)
			expect(config.default_env).toBe('keep')
			expect(config.runner_sha256).toBe(sha)
			expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files: { 'box-runner.mjs': sha } })
		})

		it('pins a manifest given as a path list', async () => {
			serve(Object.keys(BODIES))
			const out = await pinRunner(env, { ref: REF, files: ['lib/log.mjs', 'harness/claude.mjs'] })
			expect(out.status).toBe(200)
			const want: Record<string, string> = {}
			for (const [p, b] of Object.entries(BODIES)) want[p] = await hex(b)
			const config = await getFleetConfig(env)
			expect(config.runner_files).toEqual(want)
			expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files: want })
		})

		it('accepts a {path: sha256} manifest and refuses one that does not match the ref', async () => {
			const want: Record<string, string> = {}
			for (const [p, b] of Object.entries(BODIES)) want[p] = await hex(b)
			serve(Object.keys(BODIES))
			const ok = await pinRunner(env, { ref: REF, files: want })
			expect(ok.status).toBe(200)
			expect((await getFleetConfig(env)).runner_files).toEqual(want)
			fetchMock.deactivate()

			await env.FERMI_KV.put('fleet:config', '{}')
			serve(Object.keys(BODIES))
			const bad = await pinRunner(env, {
				ref: REF,
				files: { ...want, 'lib/log.mjs': 'c'.repeat(64) },
			})
			expect(bad.status).toBe(409)
			expect(await env.FERMI_KV.get('fleet:config')).toBe('{}')
		})
	})
})
