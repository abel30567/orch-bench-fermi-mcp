import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getFleetConfig, pinRunner, validateFleetConfigPatch } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'
import { clearFleet, setupFleetSchema } from './setup-d1.ts'

const REF = 'a'.repeat(40)
const SHA = 'b'.repeat(64)
const ORIGIN = 'https://raw.githubusercontent.com'
const RUNNER = 'console.log("runner")'
const SHARED = 'export const shared = 1'

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function serve(path: string, status: number, body = ''): void {
	fetchMock
		.get(ORIGIN)
		.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}` })
		.reply(status, body)
}

describe('runnerPinFromConfig', () => {
	it('reads a legacy single-file pin as a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA })).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': SHA },
		})
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA, runner_files: null }),
		).toEqual({ ref: REF, files: { 'box-runner.mjs': SHA } })
	})

	it('prefers the manifest', () => {
		const files = { 'box-runner.mjs': SHA, 'lib/shared.mjs': 'c'.repeat(64) }
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA, runner_files: files }),
		).toEqual({ ref: REF, files })
	})

	it('returns null when unset', () => {
		expect(runnerPinFromConfig({})).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF })).toBeNull()
		expect(runnerPinFromConfig({ runner_sha256: SHA })).toBeNull()
	})

	it.each([
		['no entry point', { 'lib/shared.mjs': SHA }],
		['empty', {}],
		['array', ['box-runner.mjs']],
		['short hash', { 'box-runner.mjs': 'abc' }],
		['uppercase hash', { 'box-runner.mjs': 'B'.repeat(64) }],
		['non-string hash', { 'box-runner.mjs': 1 }],
		['parent traversal', { 'box-runner.mjs': SHA, '../etc/passwd': SHA }],
		['nested traversal', { 'box-runner.mjs': SHA, 'lib/../../x.mjs': SHA }],
		['dot segment', { 'box-runner.mjs': SHA, './x.mjs': SHA }],
		['stdin path', { 'box-runner.mjs': SHA, '-': SHA }],
		['leading dash', { 'box-runner.mjs': SHA, '-x.mjs': SHA }],
		['nested leading dash', { 'box-runner.mjs': SHA, 'lib/-': SHA }],
		['__proto__ key', JSON.parse(`{"box-runner.mjs":"${SHA}","__proto__":"${SHA}"}`)],
		['nested __proto__', { 'box-runner.mjs': SHA, 'lib/__proto__': SHA }],
		['absolute path', { 'box-runner.mjs': SHA, '/etc/passwd': SHA }],
		['empty segment', { 'box-runner.mjs': SHA, 'lib//x.mjs': SHA }],
		['trailing slash', { 'box-runner.mjs': SHA, 'lib/': SHA }],
		['backslash', { 'box-runner.mjs': SHA, 'lib\\x.mjs': SHA }],
		['shell quote', { 'box-runner.mjs': SHA, "x';reboot;'.mjs": SHA }],
		['newline', { 'box-runner.mjs': SHA, 'x\n.mjs': SHA }],
		['too long', { 'box-runner.mjs': SHA, [`${'x'.repeat(101)}`]: SHA }],
		[
			'too many files',
			Object.fromEntries([
				['box-runner.mjs', SHA],
				...Array.from({ length: 24 }, (_, i) => [`f${i}.mjs`, SHA]),
			]),
		],
	])('never downgrades an invalid manifest to the legacy pin: %s', (_name, runner_files) => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: SHA, runner_files })).toBeNull()
		expect(() => runnerFetchScript({ ref: REF, files: runner_files as never })).toThrow()
	})

	it('rejects a ref that could reach the shell', () => {
		expect(runnerPinFromConfig({ runner_ref: "main';reboot;'", runner_sha256: SHA })).toBeNull()
		expect(() =>
			runnerFetchScript({ ref: "main';reboot;'", files: { 'box-runner.mjs': SHA } }),
		).toThrow()
	})
})

describe('runnerFetchScript', () => {
	it('fetches every file from the ref, then verifies, then installs', () => {
		const files = { 'box-runner.mjs': SHA, 'lib/shared.mjs': 'c'.repeat(64) }
		const script = runnerFetchScript({ ref: REF, files })
		expect(runnerUrl(REF)).toBe(`${ORIGIN}/abel30567/fermi-daemon/${REF}/box-runner.mjs`)
		expect(script).toContain('curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors')
		expect(script).toContain(`'${runnerUrl(REF, 'lib/shared.mjs')}'`)
		expect(script).toContain(`${'c'.repeat(64)}  lib/shared.mjs`)
		const lastFetch = script.lastIndexOf('fetch_runner_file ')
		const verify = script.indexOf('sha256sum --strict -c -')
		const firstInstall = script.indexOf("install_runner_file 'box-runner.mjs'")
		expect(lastFetch).toBeLessThan(verify)
		expect(verify).toBeLessThan(firstInstall)
	})
})

describe('bootstrapUserData', () => {
	it('verifies the whole pin before the box token lands, and stays inside EC2 limits', () => {
		const files = Object.fromEntries([
			['box-runner.mjs', SHA],
			...Array.from({ length: 23 }, (_, i) => [`${'x'.repeat(96)}${i}`.slice(-100), SHA]),
		])
		const script = bootstrapUserData({
			boxId: 'box-1',
			agentId: 'ca_1',
			queue: 'agent:ca_1',
			route: 'claude',
			ttlSeconds: 600,
			mcpBaseUrl: null,
			boxToken: 'box-1.secret',
			claudeModel: null,
			runnerPin: { ref: REF, files },
		})
		const verify = script.indexOf('sha256sum --strict -c -')
		expect(verify).toBeGreaterThan(-1)
		expect(verify).toBeLessThan(script.indexOf('FERMI_BOX_TOKEN='))
		expect(script.length).toBeLessThan(16 * 1024)
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

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
	})

	it.each([
		['missing', {}],
		['a branch', { ref: 'main' }],
		['shell metacharacters', { ref: "abcdef0';reboot;'" }],
	])('returns 400 on a bad ref: %s', async (_name, body) => {
		expect(await pinRunner(env, body)).toMatchObject({ ok: false, status: 400 })
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it.each([
		['null', null],
		['array', ['box-runner.mjs']],
		['no entry point', { 'lib/shared.mjs': SHA }],
		['unsafe path', { 'box-runner.mjs': SHA, '../x.mjs': SHA }],
		['bad hash', { 'box-runner.mjs': 'nope' }],
		['stdin path', { 'box-runner.mjs': SHA, '-': SHA }],
		['__proto__ key', JSON.parse(`{"box-runner.mjs":"${SHA}","__proto__":"${SHA}"}`)],
	])('returns 400 on malformed files without fetching: %s', async (_name, files) => {
		expect(await pinRunner(env, { ref: REF, files })).toMatchObject({ ok: false, status: 400 })
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('legacy pin hashes box-runner.mjs and keeps other config', async () => {
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ max_concurrent: 9 }))
		serve('box-runner.mjs', 200, RUNNER)
		const hash = await sha256(RUNNER)
		expect(await pinRunner(env, { ref: REF })).toEqual({
			ok: true,
			status: 200,
			ref: REF,
			sha256: hash,
			files: { 'box-runner.mjs': hash },
			bytes: RUNNER.length,
		})
		expect(JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')).toEqual({
			max_concurrent: 9,
			runner_ref: REF,
			runner_sha256: hash,
			runner_files: null,
		})
	})

	it('stores a manifest whose hashes match the ref, and legacy readers still see the runner hash', async () => {
		serve('box-runner.mjs', 200, RUNNER)
		serve('lib/shared.mjs', 200, SHARED)
		const files = { 'box-runner.mjs': await sha256(RUNNER), 'lib/shared.mjs': await sha256(SHARED) }
		expect(await pinRunner(env, { ref: REF, files })).toMatchObject({
			ok: true,
			status: 200,
			files,
		})
		const config = await getFleetConfig(env)
		expect(config).toMatchObject({
			runner_ref: REF,
			runner_sha256: files['box-runner.mjs'],
			runner_files: files,
		})
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files })
	})

	it('a later single-file pin drops the stale manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				runner_ref: 'c'.repeat(40),
				runner_sha256: SHA,
				runner_files: { 'box-runner.mjs': SHA, 'lib/shared.mjs': SHA },
			}),
		)
		serve('box-runner.mjs', 200, RUNNER)
		await pinRunner(env, { ref: REF })
		const hash = await sha256(RUNNER)
		expect(runnerPinFromConfig(await getFleetConfig(env))).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': hash },
		})
	})

	it('refuses a manifest the ref does not serve, leaving the old pin in place', async () => {
		const before = JSON.stringify({ runner_ref: 'c'.repeat(40), runner_sha256: SHA })
		await env.FERMI_KV.put('fleet:config', before)
		const files = { 'box-runner.mjs': await sha256(RUNNER), 'lib/shared.mjs': SHA }

		serve('box-runner.mjs', 200, RUNNER)
		serve('lib/shared.mjs', 200, SHARED)
		expect(await pinRunner(env, { ref: REF, files })).toMatchObject({
			ok: false,
			status: 409,
			error: 'sha256_mismatch',
			path: 'lib/shared.mjs',
		})

		serve('box-runner.mjs', 200, RUNNER)
		serve('lib/shared.mjs', 404)
		expect(await pinRunner(env, { ref: REF, files })).toMatchObject({
			ok: false,
			status: 502,
			error: 'fetch_404',
			path: 'lib/shared.mjs',
		})
		expect(await env.FERMI_KV.get('fleet:config')).toBe(before)
	})

	it('answers 502 when the fetch itself fails', async () => {
		fetchMock
			.get(ORIGIN)
			.intercept({ path: `/abel30567/fermi-daemon/${REF}/box-runner.mjs` })
			.replyWithError(new Error('boom'))
		expect(await pinRunner(env, { ref: REF })).toMatchObject({ ok: false, status: 502 })
	})
})

describe('fleet:config pin gates', () => {
	beforeAll(async () => {
		await setupFleetSchema()
	})

	beforeEach(async () => {
		await clearFleet()
		await env.FERMI_KV.delete('fleet:config')
	})

	it('dispatchProvision refuses an invalid manifest instead of using the legacy hash', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				runner_ref: REF,
				runner_sha256: SHA,
				runner_files: { 'box-runner.mjs': SHA, '../x.mjs': SHA },
			}),
		)
		const outcome = await dispatchProvision(env, {
			id: 'ca_bad',
			queue: 'agent:ca_bad',
			route: 'claude',
			box_id: null,
		} as CloudAgentRow)
		expect(outcome).toMatchObject({ dispatched: false, reason: 'runner_pin_unset' })
	})

	it('runner_files cannot be set through the operator config patch', async () => {
		const config = await getFleetConfig(env)
		expect(validateFleetConfigPatch(config, { runner_files: {} })).toMatchObject({ ok: false })
	})
})
