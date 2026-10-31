import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getFleetConfig, pinRunner, updateFleetConfig } from '../src/lib/fleet-config.ts'
import { bootstrapUserData } from '../src/lib/provisioner.ts'
import { runnerFetchScript, runnerPinFromConfig, runnerUrl } from '../src/lib/runner-pin.ts'

const REF = 'a'.repeat(40)
const HASH = 'b'.repeat(64)
const OTHER = 'c'.repeat(64)
const MANIFEST = { 'box-runner.mjs': HASH, 'lib/util.mjs': OTHER }

const sha256 = async (text: string) =>
	[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
		.map((x) => x.toString(16).padStart(2, '0'))
		.join('')

function serve(path: string, body: string, status = 200) {
	fetchMock
		.get('https://raw.githubusercontent.com')
		.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}` })
		.reply(status, body)
}

describe('runnerPinFromConfig', () => {
	it('turns a legacy single-file pin into a one-entry manifest', () => {
		const pin = { ref: REF, files: { 'box-runner.mjs': HASH } }
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: HASH })).toEqual(pin)
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: HASH, runner_files: null }),
		).toEqual(pin)
	})

	it('reads a manifest', () => {
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: HASH, runner_files: MANIFEST }),
		).toEqual({ ref: REF, files: MANIFEST })
	})

	it('is null when unset', () => {
		expect(runnerPinFromConfig({ runner_ref: null, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: null })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: null, runner_files: MANIFEST })).toBeNull()
	})

	it.each([
		['missing box-runner.mjs', { 'lib/util.mjs': HASH }],
		['empty', {}],
		['an array', [HASH]],
		['a short hash', { 'box-runner.mjs': 'abc' }],
		['parent traversal', { 'box-runner.mjs': HASH, '../evil.mjs': HASH }],
		['inner traversal', { 'box-runner.mjs': HASH, 'lib/../../evil.mjs': HASH }],
		['an absolute path', { 'box-runner.mjs': HASH, '/etc/passwd': HASH }],
		['a shell quote', { 'box-runner.mjs': HASH, "x'; reboot; '": HASH }],
		['a dot segment', { 'box-runner.mjs': HASH, './lib/x.mjs': HASH }],
		['an empty segment', { 'box-runner.mjs': HASH, 'lib//x.mjs': HASH }],
		['a backslash', { 'box-runner.mjs': HASH, 'lib\\x.mjs': HASH }],
		['a newline', { 'box-runner.mjs': HASH, 'x\n.mjs': HASH }],
		['a file that is also a dir', { 'box-runner.mjs': HASH, lib: HASH, 'lib/x.mjs': HASH }],
	])('rejects a manifest with %s, without falling back to runner_sha256', (_name, files) => {
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: HASH, runner_files: files }),
		).toBeNull()
	})

	it('rejects a manifest too large for user-data', () => {
		const files = Object.fromEntries(
			Array.from({ length: 33 }, (_, i) => [i ? `lib/${i}.mjs` : 'box-runner.mjs', HASH]),
		)
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: files })).toBeNull()
	})

	it('rejects an unsafe ref or hash', () => {
		expect(runnerPinFromConfig({ runner_ref: "a'b", runner_sha256: HASH })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: '../main', runner_sha256: HASH })).toBeNull()
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'nope' })).toBeNull()
	})
})

describe('runnerFetchScript', () => {
	it('throws on an invalid manifest', () => {
		expect(() => runnerFetchScript({ ref: REF, files: { 'lib/x.mjs': HASH } })).toThrow()
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'box-runner.mjs': HASH, '../x': HASH } }),
		).toThrow()
		expect(() => runnerFetchScript({ ref: "x'", files: { 'box-runner.mjs': HASH } })).toThrow()
	})

	it('verifies every file before installing any, entry point last', () => {
		const lines = runnerFetchScript({ ref: REF, files: MANIFEST }).split('\n')
		const curls = lines.filter((l) => l.startsWith('curl '))
		expect(curls).toHaveLength(2)
		expect(curls[0]).toContain(runnerUrl(REF, 'lib/util.mjs'))
		expect(lines.filter((l) => l.includes('sha256sum -c'))).toHaveLength(2)
		const lastCheck = lines.findLastIndex((l) => l.includes('sha256sum -c'))
		const firstMove = lines.findIndex((l) => l.startsWith('mv '))
		expect(lastCheck).toBeLessThan(firstMove)
		expect(lines.filter((l) => l.startsWith('mv ')).pop()).toContain("'/opt/fermi/box-runner.mjs'")
	})
})

describe('runnerUrl', () => {
	it('defaults to the entry point', () => {
		expect(runnerUrl(REF)).toBe(runnerUrl(REF, 'box-runner.mjs'))
		expect(runnerUrl(REF, 'lib/util.mjs')).toMatch(new RegExp(`/${REF}/lib/util\\.mjs$`))
	})
})

describe('bootstrapUserData', () => {
	it('fetches the whole manifest before the box token exists', () => {
		const data = bootstrapUserData({
			boxId: 'box-1',
			agentId: 'ca_1',
			queue: 'agent:ca_1',
			route: 'claude',
			ttlSeconds: 600,
			mcpBaseUrl: null,
			boxToken: 'box-1.secret',
			claudeModel: null,
			runnerPin: { ref: REF, files: MANIFEST },
		})
		expect(data.match(/sha256sum -c/g)).toHaveLength(2)
		expect(data.lastIndexOf('sha256sum -c')).toBeLessThan(data.indexOf('FERMI_BOX_TOKEN='))
	})
})

describe('pinRunner', () => {
	beforeAll(() => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	beforeEach(() => env.FERMI_KV.delete('fleet:config'))
	afterEach(() => fetchMock.assertNoPendingInterceptors())

	it('keeps the legacy single-file pin working', async () => {
		serve('box-runner.mjs', 'runner')
		const result = await pinRunner(env, { ref: REF })
		const hash = await sha256('runner')
		expect(result).toEqual({
			status: 200,
			body: { ok: true, ref: REF, sha256: hash, bytes: 6 },
		})
		const config = await getFleetConfig(env)
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files: { 'box-runner.mjs': hash } })
	})

	it('stores a manifest whose hashes match the ref', async () => {
		serve('box-runner.mjs', 'runner')
		serve('lib/util.mjs', 'util')
		const files = {
			'box-runner.mjs': await sha256('runner'),
			'lib/util.mjs': await sha256('util'),
		}
		const result = await pinRunner(env, { ref: REF, files })
		expect(result.status).toBe(200)
		expect(result.body).toMatchObject({ ok: true, files, sha256: files['box-runner.mjs'] })
		expect(runnerPinFromConfig(await getFleetConfig(env))).toEqual({ ref: REF, files })
	})

	it('a later legacy pin replaces an earlier manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ runner_ref: 'd'.repeat(40), runner_sha256: HASH, runner_files: MANIFEST }),
		)
		serve('box-runner.mjs', 'runner')
		expect((await pinRunner(env, { ref: REF })).status).toBe(200)
		expect(runnerPinFromConfig(await getFleetConfig(env))).toEqual({
			ref: REF,
			files: { 'box-runner.mjs': await sha256('runner') },
		})
	})

	it('preserves the rest of fleet:config', async () => {
		await updateFleetConfig(env, { max_concurrent: 9 })
		serve('box-runner.mjs', 'runner')
		await pinRunner(env, { ref: REF })
		expect((await getFleetConfig(env)).max_concurrent).toBe(9)
	})

	it.each([
		['a missing ref', {}],
		['a non-sha ref', { ref: 'main' }],
		['a non-string ref', { ref: 7 }],
		['null files', { ref: REF, files: null }],
		['array files', { ref: REF, files: ['box-runner.mjs'] }],
		['files without the entry point', { ref: REF, files: { 'lib/x.mjs': HASH } }],
		['an unsafe path', { ref: REF, files: { 'box-runner.mjs': HASH, '../x': HASH } }],
		['a bad hash', { ref: REF, files: { 'box-runner.mjs': 'nope' } }],
	])('answers 400 on %s without pinning', async (_name, input) => {
		expect((await pinRunner(env, input)).status).toBe(400)
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('refuses a manifest that does not match the ref, leaving the pin alone', async () => {
		serve('box-runner.mjs', 'runner')
		serve('lib/util.mjs', 'not what was pinned')
		const result = await pinRunner(env, {
			ref: REF,
			files: { 'box-runner.mjs': await sha256('runner'), 'lib/util.mjs': OTHER },
		})
		expect(result.status).toBe(409)
		expect(result.body).toMatchObject({ error: 'hash_mismatch', path: 'lib/util.mjs' })
		expect(await env.FERMI_KV.get('fleet:config')).toBeNull()
	})

	it('answers 502 when a file cannot be fetched', async () => {
		serve('box-runner.mjs', 'gone', 404)
		const result = await pinRunner(env, { ref: REF })
		expect(result).toMatchObject({ status: 502, body: { error: 'fetch_404' } })
	})

	it('cannot be bypassed through the operator config endpoint', async () => {
		expect(await updateFleetConfig(env, { runner_files: MANIFEST })).toMatchObject({ ok: false })
	})
})
