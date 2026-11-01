import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pinRunner } from '../src/lib/fleet-config.ts'
import type { CloudAgentRow } from '../src/lib/fleet-store.ts'
import { bootstrapUserData, dispatchProvision } from '../src/lib/provisioner.ts'
import {
	EC2_USER_DATA_MAX_BYTES,
	MAX_RUNNER_FILES,
	MAX_RUNNER_MANIFEST_BYTES,
	runnerFetchScript,
	runnerFilesError,
	runnerPinFromConfig,
	runnerUrl,
} from '../src/lib/runner-pin.ts'
import { setupFleetSchema } from './setup-d1.ts'

const REF = 'a'.repeat(40)
const PIN = { ref: REF, files: { 'box-runner.mjs': 'b'.repeat(64) } }
const MANIFEST = {
	ref: REF,
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

async function sha256(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('runner boot pin (#34)', () => {
	beforeAll(setupFleetSchema)

	it('fetch script pins the ref and verifies sha256 with no fallback', () => {
		const script = runnerFetchScript(PIN)
		// Paths come from the inlined manifest; every URL is under the pinned ref.
		expect(script).toContain(`"${runnerUrl(PIN.ref, '')}$p"`)
		expect(script).toContain(`${PIN.files['box-runner.mjs']}  box-runner.mjs`)
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

		// An invalid manifest is as good as no pin.
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({
				default_env: 'test-env',
				runner_ref: REF,
				runner_files: { '../etc/passwd': 'b'.repeat(64) },
			}),
		)
		expect((await dispatchProvision(env, agent)).reason).toBe('runner_pin_unset')
	})
})

describe('runner pin manifest (pr-55)', () => {
	it('reads a legacy single-file pin as a one-file manifest', () => {
		expect(runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'b'.repeat(64) })).toEqual(PIN)
		expect(
			runnerPinFromConfig({ runner_ref: REF, runner_sha256: 'b'.repeat(64), runner_files: null }),
		).toEqual(PIN)
	})

	it('reads a manifest pin', () => {
		expect(
			runnerPinFromConfig({
				runner_ref: REF,
				runner_sha256: 'b'.repeat(64),
				runner_files: MANIFEST.files,
			}),
		).toEqual(MANIFEST)
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: MANIFEST.files })).toEqual(MANIFEST)
	})

	it('returns null for an unset or invalid pin', () => {
		const sha = 'b'.repeat(64)
		const bad = [
			{},
			{ runner_ref: null, runner_sha256: null },
			{ runner_ref: REF },
			{ runner_sha256: sha },
			{ runner_ref: REF, runner_sha256: 'nothex' },
			{ runner_ref: "x'; rm -rf /", runner_sha256: sha },
			{ runner_ref: REF, runner_files: { 'lib/util.mjs': sha } }, // no box-runner.mjs
			{ runner_ref: REF, runner_files: ['box-runner.mjs'] },
			{ runner_ref: REF, runner_files: { 'box-runner.mjs': sha, 'lib/x.mjs': 'short' } },
			{ runner_ref: REF, runner_sha256: 'c'.repeat(64), runner_files: { 'box-runner.mjs': sha } },
		]
		for (const config of bad) expect(runnerPinFromConfig(config), JSON.stringify(config)).toBeNull()
		for (const path of ['../x.mjs', '/etc/x', 'lib/../x', './x', 'lib//x', "x'y", 'x y', '']) {
			const files = { 'box-runner.mjs': sha, [path]: sha }
			expect(runnerPinFromConfig({ runner_ref: REF, runner_files: files }), path).toBeNull()
		}
	})

	it('runnerFetchScript throws on an invalid manifest', () => {
		expect(() =>
			runnerFetchScript({ ref: REF, files: { 'lib/util.mjs': 'b'.repeat(64) } }),
		).toThrow()
		expect(() =>
			runnerFetchScript({
				ref: REF,
				files: { 'box-runner.mjs': 'b'.repeat(64), '../x': 'b'.repeat(64) },
			}),
		).toThrow()
		expect(() => runnerFetchScript({ ref: 'bad ref', files: PIN.files })).toThrow()
	})

	it('fetches every manifest file at the ref and verifies all before installing any', () => {
		const script = runnerFetchScript(MANIFEST)
		const lines = script.split('\n')
		const fetchAt = lines.findIndex((l) => l.includes('curl '))
		const verifyAt = lines.findIndex((l) => l.includes('sha256sum -c .sha256'))
		const installAt = lines.findIndex((l) => l.includes('mv '))
		expect(script).toContain(`"${runnerUrl(REF, '')}$p"`)
		for (const [path, sha] of Object.entries(MANIFEST.files)) {
			expect(lines.indexOf(`${sha}  ${path}`)).toBeGreaterThan(-1)
			expect(lines.indexOf(`${sha}  ${path}`)).toBeLessThan(fetchAt)
		}
		expect(verifyAt).toBeGreaterThan(fetchAt)
		expect(installAt).toBeGreaterThan(verifyAt)
	})

	// EC2 RunInstances rejects user-data over 16 KB: a pin that passes
	// validation must always fit, however many files or long paths it lists.
	it('every valid manifest fits in EC2 user-data', () => {
		const sha = 'b'.repeat(64)
		const longRef = `r${'a'.repeat(127)}`
		// Fill the manifest budget to the byte with the most files allowed.
		const atCap = (count: number): Record<string, string> => {
			const files: Record<string, string> = { 'box-runner.mjs': sha }
			let used = 64 + 2 + 'box-runner.mjs'.length + 1
			for (let i = 1; i < count; i++) {
				const left = count - i
				const len = Math.min(200, Math.floor((MAX_RUNNER_MANIFEST_BYTES - used) / left) - 67)
				const stem = `harness/m${i}_`
				const path = `${stem}${'x'.repeat(len - stem.length - 4)}.mjs`
				files[path] = sha
				used += 64 + 2 + path.length + 1
			}
			return files
		}
		for (const files of [atCap(MAX_RUNNER_FILES), atCap(8), atCap(2)]) {
			const pin = runnerPinFromConfig({ runner_ref: longRef, runner_files: files })
			expect(pin, `${Object.keys(files).length} files`).not.toBeNull()
			const ud = userData({
				runnerPin: pin as NonNullable<typeof pin>,
				boxToken: `box-test.${'x'.repeat(64)}`,
				mcpBaseUrl: 'https://fermi.example.workers.dev',
				claudeModel: 'claude-opus-5-5',
			})
			expect(new TextEncoder().encode(ud).length).toBeLessThanOrEqual(EC2_USER_DATA_MAX_BYTES)
		}
	})

	it('rejects a manifest over the user-data budget', () => {
		const sha = 'b'.repeat(64)
		const files: Record<string, string> = { 'box-runner.mjs': sha }
		for (let i = 1; i < MAX_RUNNER_FILES; i++) files[`harness/${'m'.repeat(60)}${i}.mjs`] = sha
		expect(runnerFilesError(files)).toMatch(/fit in EC2 user-data/)
		expect(runnerPinFromConfig({ runner_ref: REF, runner_files: files })).toBeNull()
	})

	it('user-data verifies every manifest file before the box token', () => {
		const script = userData({ runnerPin: MANIFEST })
		const tokenAt = script.indexOf('FERMI_BOX_TOKEN=')
		for (const sha of Object.values(MANIFEST.files)) {
			expect(script.indexOf(sha)).toBeGreaterThan(-1)
			expect(script.indexOf(sha)).toBeLessThan(tokenAt)
		}
	})

	it('runnerUrl defaults to box-runner.mjs and accepts a path', () => {
		expect(runnerUrl(REF)).toBe(runnerUrl(REF, 'box-runner.mjs'))
		expect(runnerUrl(REF, 'harness/claude.mjs')).toMatch(
			new RegExp(`/${REF}/harness/claude\\.mjs$`),
		)
	})
})

describe('pinRunner (pr-55)', () => {
	const RAW = 'https://raw.githubusercontent.com'
	const BODY = {
		'box-runner.mjs': 'runner',
		'harness/claude.mjs': 'harness',
		'lib/util.mjs': 'util',
	}
	const serve = (path: string, body: string, status = 200) =>
		fetchMock
			.get(RAW)
			.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}` })
			.reply(status, body)
	const stored = async () => JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}')

	beforeEach(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		await env.FERMI_KV.put('fleet:config', JSON.stringify({ max_concurrent: 3 }))
	})
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors()
		fetchMock.deactivate()
	})

	it('legacy {ref} hashes box-runner.mjs and clears any manifest', async () => {
		await env.FERMI_KV.put(
			'fleet:config',
			JSON.stringify({ max_concurrent: 3, runner_files: { 'box-runner.mjs': 'e'.repeat(64) } }),
		)
		serve('box-runner.mjs', 'runner')
		const out = await pinRunner(env, { ref: REF })
		const sha = await sha256('runner')
		expect(out).toEqual({ status: 200, body: { ok: true, ref: REF, sha256: sha, bytes: 6 } })
		const config = await stored()
		expect(config).toEqual({
			max_concurrent: 3,
			runner_ref: REF,
			runner_sha256: sha,
			runner_files: null,
		})
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files: { 'box-runner.mjs': sha } })
	})

	it('manifest {ref, files} fetches and verifies every file, then stores the manifest', async () => {
		const files: Record<string, string> = {}
		for (const [p, b] of Object.entries(BODY)) {
			files[p] = await sha256(b)
			serve(p, b)
		}
		const out = await pinRunner(env, { ref: REF, files })
		expect(out.status).toBe(200)
		expect(out.body).toMatchObject({ ok: true, ref: REF, sha256: files['box-runner.mjs'], files })
		const config = await stored()
		expect(config).toMatchObject({
			max_concurrent: 3,
			runner_ref: REF,
			runner_sha256: files['box-runner.mjs'],
			runner_files: files,
		})
		expect(runnerPinFromConfig(config)).toEqual({ ref: REF, files })
	})

	it('refuses a manifest whose hash does not match the fetched file (409, nothing stored)', async () => {
		const files: Record<string, string> = {}
		for (const [p, b] of Object.entries(BODY)) {
			files[p] = await sha256(b)
			serve(p, p === 'lib/util.mjs' ? 'tampered' : b)
		}
		const out = await pinRunner(env, { ref: REF, files })
		expect(out.status).toBe(409)
		expect(out.body).toMatchObject({ ok: false, error: 'sha256_mismatch', paths: ['lib/util.mjs'] })
		expect(await stored()).toEqual({ max_concurrent: 3 })
	})

	it('refuses when a manifest file is missing upstream (502, nothing stored)', async () => {
		serve('box-runner.mjs', 'runner')
		serve('lib/util.mjs', 'nope', 404)
		const files = { 'box-runner.mjs': await sha256('runner'), 'lib/util.mjs': await sha256('util') }
		const out = await pinRunner(env, { ref: REF, files })
		expect(out).toEqual({
			status: 502,
			body: { ok: false, error: 'fetch_404', path: 'lib/util.mjs' },
		})
		expect(await stored()).toEqual({ max_concurrent: 3 })
	})

	it('returns 400 on a bad ref or malformed files without fetching', async () => {
		const sha = 'b'.repeat(64)
		const cases: Array<{ ref?: unknown; files?: unknown }> = [
			{},
			{ ref: 'main' },
			{ ref: REF.toUpperCase() },
			{ ref: REF, files: null },
			{ ref: REF, files: ['box-runner.mjs'] },
			{ ref: REF, files: { 'lib/util.mjs': sha } },
			{ ref: REF, files: { 'box-runner.mjs': 'xyz' } },
			{ ref: REF, files: { 'box-runner.mjs': sha, '../escape.mjs': sha } },
			{ ref: REF, files: { 'box-runner.mjs': sha, '/abs.mjs': sha } },
			// Too large for EC2 user-data: would store a pin that can never launch.
			{
				ref: REF,
				files: Object.fromEntries([
					['box-runner.mjs', sha],
					...Array.from({ length: 40 }, (_, i) => [`harness/${'m'.repeat(150)}${i}.mjs`, sha]),
				]),
			},
		]
		for (const body of cases) {
			const out = await pinRunner(env, body)
			expect(out.status, JSON.stringify(body)).toBe(400)
			expect(out.body.ok).toBe(false)
		}
		expect(await stored()).toEqual({ max_concurrent: 3 })
	})
})
