import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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
		'lib/util.mjs': 'c'.repeat(64),
		'harness/claude.mjs': 'd'.repeat(64),
	},
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
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

	it('manifest fetch script fetches and verifies every file before the token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(runnerUrl(REF, path))
			expect(script).toContain(`${sha}  ${path}`)
			expect(script.indexOf(sha)).toBeLessThan(tokenAt)
		}
		expect(script).toContain(
			"mv -f '/opt/fermi/.runner-staging/lib/util.mjs' '/opt/fermi/lib/util.mjs'",
		)
	})

	it('legacy single-file pin resolves to a one-file manifest with the same layout', () => {
		const pin = runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'b'.repeat(64) })
		expect(pin).toEqual(PIN)
		expect(runnerUrl(REF)).toBe(runnerUrl(REF, 'box-runner.mjs'))
		expect(runnerFetchScript(PIN)).toContain("'/opt/fermi/box-runner.mjs'")
	})

	it('runnerPinFromConfig prefers the manifest and rejects unset or invalid pins', () => {
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: 'b'.repeat(64),
				runner_files: MANIFEST.files,
			}),
		).toEqual(MANIFEST)
		const sha = 'e'.repeat(64)
		for (const cfg of [
			{ runner_ref: null, runner_sha256: null },
			{ runner_ref: REF, runner_sha256: null },
			{ runner_ref: null, runner_sha256: sha },
			{ runner_ref: REF, runner_sha256: 'not-a-sha' },
			{ runner_ref: "x'; rm -rf /", runner_sha256: sha },
			{ runner_ref: REF, runner_files: {} },
			{ runner_ref: REF, runner_files: [] },
			{ runner_ref: REF, runner_files: { 'lib/util.mjs': sha } },
			{ runner_ref: REF, runner_files: { 'box-runner.mjs': 'short' } },
			{ runner_ref: REF, runner_files: { 'box-runner.mjs': sha, '../evil.mjs': sha } },
			{ runner_ref: REF, runner_files: { 'box-runner.mjs': sha, '/etc/passwd': sha } },
			{ runner_ref: REF, runner_files: { 'box-runner.mjs': sha, 'lib//x.mjs': sha } },
			{ runner_ref: REF, runner_files: { 'box-runner.mjs': sha, "lib/x'.mjs": sha } },
			// An invalid manifest never falls back to the legacy hash.
			{ runner_ref: REF, runner_sha256: sha, runner_files: { 'lib/util.mjs': sha } },
		]) {
			expect(runnerPinFromConfig(cfg), JSON.stringify(cfg)).toBeNull()
		}
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		const sha = 'e'.repeat(64)
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/util.mjs': sha } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': sha, '../x.mjs': sha } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': 'nope' } })).toThrow()
		expect(() => runnerFetchScript({ ref: "a'b", files: { 'box-runner.mjs': sha } })).toThrow()
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

		// A manifest without box-runner.mjs is no pin at all.
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: REF,
				runner_sha256: 'b'.repeat(64),
				runner_files: { 'lib/util.mjs': 'c'.repeat(64) },
			}),
		)
		const bad = await dispatchProvision(env, { ...agent, id: 'ca_badmanifest' })
		expect(bad).toMatchObject({ dispatched: false, reason: 'runner_pin_unset' })
	})
})

describe('pinRunner (POST /admin/fleet/pin-runner)', () => {
	const ORIGIN = 'https://raw.githubusercontent.com'
	const BODIES: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")\n',
		'lib/util.mjs': 'export const x = 1\n',
	}

	function serve(bodies: Record<string, string>) {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		for (const [path, body] of Object.entries(bodies)) {
			fetchMock
				.get(ORIGIN)
				.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}` })
				.reply(200, body)
		}
	}

	afterEach(() => {
		fetchMock.deactivate()
	})

	async function stored() {
		return JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')
	}

	it('rejects a bad ref or a malformed files manifest with 400', async () => {
		const sha = 'e'.repeat(64)
		for (const body of [
			{},
			{ ref: 'main' },
			{ ref: "abc1234'" },
			{ ref: REF, files: null },
			{ ref: REF, files: ['box-runner.mjs'] },
			{ ref: REF, files: {} },
			{ ref: REF, files: { 'lib/util.mjs': sha } },
			{ ref: REF, files: { 'box-runner.mjs': 'xyz' } },
			{ ref: REF, files: { 'box-runner.mjs': sha, '../up.mjs': sha } },
		]) {
			const res = await pinRunner(env, body)
			expect(res.status, JSON.stringify(body)).toBe(400)
			expect(res.body.ok).toBe(false)
		}
	})

	it('legacy { ref } pins box-runner.mjs and clears any stale manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ default_env: 'keep', runner_files: { 'box-runner.mjs': 'f'.repeat(64) } }),
		)
		serve({ 'box-runner.mjs': BODIES['box-runner.mjs'] })
		const res = await pinRunner(env, { ref: REF })
		const sha = await sha256(BODIES['box-runner.mjs'])
		expect(res).toMatchObject({ status: 200, body: { ok: true, ref: REF, sha256: sha } })
		const cfg = await stored()
		expect(cfg).toMatchObject({ default_env: 'keep', runner_ref: REF, runner_sha256: sha })
		expect(cfg.runner_files).toBeNull()
		expect(runnerPinFromConfig(cfg)).toEqual({ ref: REF, files: { 'box-runner.mjs': sha } })
	})

	it('manifest pin verifies every file at the ref and stores runner_files', async () => {
		const files = {
			'box-runner.mjs': await sha256(BODIES['box-runner.mjs']),
			'lib/util.mjs': await sha256(BODIES['lib/util.mjs']),
		}
		serve(BODIES)
		const res = await pinRunner(env, { ref: REF, files })
		expect(res).toMatchObject({ status: 200, body: { ok: true, files } })
		const cfg = await stored()
		expect(cfg).toMatchObject({
			runner_ref: REF,
			runner_sha256: files['box-runner.mjs'],
			runner_files: files,
		})
		expect(runnerPinFromConfig(cfg)).toEqual({ ref: REF, files })
	})

	it('manifest pin refuses a hash that does not match the ref, writing nothing', async () => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ runner_ref: 'before' }))
		serve(BODIES)
		const res = await pinRunner(env, {
			ref: REF,
			files: {
				'box-runner.mjs': await sha256(BODIES['box-runner.mjs']),
				'lib/util.mjs': 'e'.repeat(64),
			},
		})
		expect(res).toMatchObject({ status: 422, body: { ok: false, path: 'lib/util.mjs' } })
		expect((await stored()).runner_ref).toBe('before')
	})
})
