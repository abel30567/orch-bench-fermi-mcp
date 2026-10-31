import { createExecutionContext, env, fetchMock } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import worker from '../../src/index.ts'

// The contract wrangler config has no bearer token, so call the worker entry
// directly with one rather than going through SELF.

const REF = 'a'.repeat(40)
const RUNNER = 'console.log("runner")'

function post(body: unknown, token = 'contract-bearer'): Promise<Response> {
	const request = new Request('http://fermi.test/admin/fleet/pin-runner', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	}) as Parameters<typeof worker.fetch>[0]
	return worker.fetch(
		request,
		{ ...env, FERMI_BEARER_TOKEN: 'contract-bearer' },
		createExecutionContext(),
	)
}

function serveRunner(path: string, body: string): void {
	fetchMock
		.get('https://raw.githubusercontent.com')
		.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}` })
		.reply(200, body)
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('POST /admin/fleet/pin-runner', () => {
	afterEach(() => env.FERMI_KV.delete('fleet:config'))

	it('requires the bearer token', async () => {
		expect((await post({ ref: REF }, 'wrong')).status).toBe(401)
	})

	it('answers 400 on a bad ref or malformed files', async () => {
		expect((await post({ ref: 'main' })).status).toBe(400)
		expect((await post({ ref: REF, files: { 'box-runner.mjs': 'x' } })).status).toBe(400)
		expect((await post({ ref: REF, files: { 'lib/x.mjs': 'a'.repeat(64) } })).status).toBe(400)
	})

	it('keeps the single-file response shape', async () => {
		serveRunner('box-runner.mjs', RUNNER)
		const res = await post({ ref: REF })
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			ok: true,
			ref: REF,
			sha256: await sha256(RUNNER),
			bytes: RUNNER.length,
		})
	})

	it('accepts a manifest', async () => {
		serveRunner('box-runner.mjs', RUNNER)
		serveRunner('lib/shared.mjs', 'shared')
		const files = {
			'box-runner.mjs': await sha256(RUNNER),
			'lib/shared.mjs': await sha256('shared'),
		}
		const res = await post({ ref: REF, files })
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ ok: true, files })
		expect(JSON.parse((await env.FERMI_KV.get('fleet:config')) ?? '{}').runner_files).toEqual(files)
	})
})
