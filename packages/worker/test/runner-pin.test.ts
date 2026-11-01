import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const SHA = 'b'.repeat(64)
const PIN = { ref: 'a'.repeat(40), files: { 'box-runner.mjs': SHA } }
const MANIFEST = {
	ref: 'a'.repeat(40),
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

describe('runner boot pin (#34)', () => {
	beforeAll(setupFleetSchema)

	it('fetch script pins the ref and verifies sha256 with no fallback', () => {
		const script = runnerFetchScript(PIN)
		expect(script).toContain(runnerUrl(PIN.ref))
		expect(script).toContain(SHA)
		expect(script).not.toContain('/main/') // no floating branch
		expect(script).not.toContain('|| true') // fail closed, no baked-copy fallback
	})

	it('user-data verifies the runner BEFORE materializing the box token', () => {
		const script = userData()
		const verifyAt = script.indexOf(SHA)
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

	it('dispatchProvision refuses launch when the manifest is invalid', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: 'a'.repeat(40),
				runner_sha256: SHA,
				runner_files: { 'harness/x.mjs': SHA }, // no box-runner.mjs: never fall back to legacy
			}),
		)
		const out = await dispatchProvision(env, {
			id: 'ca_badmanifest',
			box_id: null,
			queue: 'default',
			route: 'claude',
		} as unknown as CloudAgentRow)
		expect(out.reason).toBe('runner_pin_unset')
	})
})

describe('runner pin manifest', () => {
	it('legacy single-file config resolves to a box-runner.mjs manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: 'v1', runner_sha256: SHA })).toEqual({
			ref: 'v1',
			files: { 'box-runner.mjs': SHA },
		})
	})

	it('runner_files wins over runner_sha256', () => {
		expect(
			runnerPinFromConfig({
				runner_ref: MANIFEST.ref,
				runner_sha256: 'e'.repeat(64),
				runner_files: MANIFEST.files,
			}),
		).toEqual(MANIFEST)
	})

	it('returns null when unset or invalid', () => {
		const ref = 'a'.repeat(40)
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: ref, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: SHA })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: ref, runner_sha256: 'nothex' })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: "x'; rm -rf /", runner_sha256: SHA })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: ref, runner_files: { 'lib/a.mjs': SHA } })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: ref, runner_files: {} })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: ref, runner_files: ['box-runner.mjs'] })).toBeNull()
		for (const bad of [
			'../evil.mjs',
			'/etc/passwd',
			'a//b.mjs',
			'lib/./x.mjs',
			"x'.mjs",
			'a b.mjs',
		]) {
			expect(
				runnerPinFromConfig({
					runner_ref: ref,
					runner_files: { 'box-runner.mjs': SHA, [bad]: SHA },
				}),
				bad,
			).toBeNull()
		}
	})

	it('runnerUrl addresses any path at the pinned ref', () => {
		expect(runnerUrl('abc')).toBe(
			'https://raw.githubusercontent.com/abel30567/fermi-daemon/abc/box-runner.mjs',
		)
		expect(runnerUrl('abc', 'harness/claude.mjs')).toBe(
			'https://raw.githubusercontent.com/abel30567/fermi-daemon/abc/harness/claude.mjs',
		)
	})

	it('fetch script fetches and verifies every manifest file before installing any', () => {
		const script = runnerFetchScript(MANIFEST)
		const lines = script.split('\n')
		const lastVerify = Math.max(...lines.map((l, i) => (l.includes('sha256sum -c') ? i : -1)))
		const firstInstall = lines.findIndex((l) => l.startsWith('mv '))
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(script).toContain(runnerUrl(MANIFEST.ref, path))
			expect(script).toContain(`${sha}  /opt/fermi/.runner-staging/${path}`)
			expect(script).toContain(`mv '/opt/fermi/.runner-staging/${path}' '/opt/fermi/${path}'`)
		}
		expect(lastVerify).toBeGreaterThan(-1)
		expect(firstInstall).toBeGreaterThan(lastVerify)
	})

	it('fetch script throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: 'v1', files: { 'lib/a.mjs': SHA } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: 'v1', files: { 'box-runner.mjs': SHA, '../x.mjs': SHA } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: 'v1', files: { 'box-runner.mjs': 'zz' } })).toThrow()
	})

	it('user-data verifies every manifest file before the box token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const sha of Object.values(MANIFEST.files)) {
			expect(script.indexOf(sha)).toBeGreaterThan(-1)
			expect(script.indexOf(sha)).toBeLessThan(tokenAt)
		}
	})
})

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('pinRunner', () => {
	const REF = '0123456789abcdef0123456789abcdef01234567'
	const BODIES: Record<string, string> = {
		'box-runner.mjs': 'console.log("runner")',
		'harness/claude.mjs': 'export const h = 1',
		'lib/util.mjs': 'export const u = 1',
	}
	const serve = (path: string) =>
		fetchMock
			.get('https://raw.githubusercontent.com')
			.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}` })
			.reply(200, BODIES[path])

	beforeEach(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ default_env: 'keep-me' }))
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	it('legacy body (ref only) pins box-runner.mjs', async () => {
		serve('box-runner.mjs')
		const out = await pinRunner(env, { ref: REF })
		const sha = await sha256(BODIES['box-runner.mjs'])
		expect(out.status).toBe(200)
		expect(out.body).toMatchObject({ ok: true, ref: REF, sha256: sha })
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) as string)
		expect(stored).toMatchObject({ default_env: 'keep-me', runner_ref: REF, runner_sha256: sha })
		expect(runnerPinFromConfig(stored)).toEqual({ ref: REF, files: { 'box-runner.mjs': sha } })
	})

	it('files array pins a manifest and always includes box-runner.mjs', async () => {
		serve('harness/claude.mjs')
		serve('lib/util.mjs')
		serve('box-runner.mjs')
		const out = await pinRunner(env, { ref: REF, files: ['harness/claude.mjs', 'lib/util.mjs'] })
		expect(out.status).toBe(200)
		const files: Record<string, string> = {}
		for (const [p, b] of Object.entries(BODIES)) files[p] = await sha256(b)
		expect(out.body.files).toEqual(files)
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) as string)
		expect(runnerPinFromConfig(stored)).toEqual({ ref: REF, files })
	})

	it('files map must match what was fetched', async () => {
		serve('box-runner.mjs')
		const out = await pinRunner(env, { ref: REF, files: { 'box-runner.mjs': 'f'.repeat(64) } })
		expect(out.status).toBe(409)
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) as string)
		expect(stored.runner_ref).toBeUndefined()
	})

	it('400 on a bad ref or malformed files, without fetching', async () => {
		for (const body of [
			null,
			{},
			{ ref: 'main' },
			{ ref: "abc1234'" },
			{ ref: REF, files: 'box-runner.mjs' },
			{ ref: REF, files: [1] },
			{ ref: REF, files: ['../evil.mjs'] },
			{ ref: REF, files: { 'lib/a.mjs': 'nothex' } },
			{ ref: REF, files: { '/etc/passwd': 'a'.repeat(64) } },
		]) {
			const out = await pinRunner(env, body)
			expect(out.status, JSON.stringify(body)).toBe(400)
		}
		const stored = JSON.parse((await env.FERMI_KV.get('fleet:config')) as string)
		expect(stored.runner_ref).toBeUndefined()
	})
})
