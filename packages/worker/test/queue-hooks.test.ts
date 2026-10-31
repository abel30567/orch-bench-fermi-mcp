import { env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireQueueHook } from '../src/lib/queue-hooks.ts'
import { putSecret } from '../src/lib/secrets-store.ts'
import { setupSecretsSchema } from './setup-d1.ts'

const testEnv = env as unknown as Env
const SECRET_VALUE = 'super-secret-value'
const task = { task_id: 't1', queue: 'grok-bot' }
const hook = {
	url: 'https://grok.example.com/wake?token=url-token',
	auth_header: 'x-routine-key',
	secret: 'GROKBOT_WEBHOOK_KEY',
}

function configure(entry: unknown) {
	return env.FERMI_KV.put('queue:hooks', JSON.stringify({ 'grok-bot': entry }))
}

function storeSecret(allowedHosts: string[]) {
	return putSecret({ name: hook.secret, value: SECRET_VALUE, scope: 'app', allowedHosts }, testEnv)
}

describe('fireQueueHook', () => {
	const fetchStub = vi.fn()
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

	beforeAll(setupSecretsSchema)
	beforeEach(async () => {
		fetchStub.mockReset()
		warn.mockClear()
		vi.stubGlobal('fetch', fetchStub)
		await env.FERMI_DB.prepare('DELETE FROM secrets').run()
		await env.FERMI_KV.delete('queue:hooks')
		await storeSecret(['grok.example.com'])
		await configure(hook)
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		const logged = JSON.stringify(warn.mock.calls)
		expect(logged).not.toContain(SECRET_VALUE)
		expect(logged).not.toContain('url-token')
	})

	it('POSTs { task_id, queue } with the secret-backed auth header', async () => {
		fetchStub.mockResolvedValue(new Response('ok'))
		await fireQueueHook(testEnv, task, [0])
		expect(fetchStub).toHaveBeenCalledTimes(1)
		const [url, init] = fetchStub.mock.calls[0]
		expect(url).toBe(hook.url)
		expect(init.method).toBe('POST')
		expect(init.headers['x-routine-key']).toBe(SECRET_VALUE)
		expect(init.redirect).toBe('manual')
		expect(JSON.parse(init.body)).toEqual(task)
		expect(warn).not.toHaveBeenCalled()
	})

	it('retries 429, 5xx and network errors until one succeeds', async () => {
		fetchStub
			.mockResolvedValueOnce(new Response('', { status: 429 }))
			.mockResolvedValueOnce(new Response('', { status: 503 }))
			.mockRejectedValueOnce(new Error(`boom ${SECRET_VALUE}`))
			.mockResolvedValueOnce(new Response('ok'))
		await fireQueueHook(testEnv, task, [0, 0, 0, 0, 0])
		expect(fetchStub).toHaveBeenCalledTimes(4)
		expect(warn).toHaveBeenCalledTimes(3)
	})

	it('stops after one attempt per delay and resolves', async () => {
		fetchStub.mockImplementation(async () => new Response('', { status: 500 }))
		await expect(fireQueueHook(testEnv, task, [0, 0, 0])).resolves.toBeUndefined()
		expect(fetchStub).toHaveBeenCalledTimes(3)
		expect(warn).toHaveBeenCalledTimes(3)
	})

	it('waits before an attempt, not after the last one', async () => {
		fetchStub.mockImplementation(async () => new Response('', { status: 500 }))
		const started = Date.now()
		await fireQueueHook(testEnv, task, [0, 30])
		expect(fetchStub).toHaveBeenCalledTimes(2)
		expect(Date.now() - started).toBeGreaterThanOrEqual(25)
	})

	it.each([400, 401, 404, 302])('does not retry a %i', async (status) => {
		fetchStub.mockResolvedValue(new Response(null, { status }))
		await fireQueueHook(testEnv, task, [0, 0, 0])
		expect(fetchStub).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it('is a no-op with no config, another queue, or a partial entry', async () => {
		await env.FERMI_KV.delete('queue:hooks')
		await fireQueueHook(testEnv, task, [0])
		await configure(hook)
		await fireQueueHook(testEnv, { task_id: 't1', queue: 'main' }, [0])
		await fireQueueHook(testEnv, { task_id: 't1', queue: 'constructor' }, [0])
		await configure({ auth_header: hook.auth_header, secret: hook.secret })
		await fireQueueHook(testEnv, task, [0])
		await configure({ url: hook.url, auth_header: hook.auth_header })
		await fireQueueHook(testEnv, task, [0])
		expect(fetchStub).not.toHaveBeenCalled()
	})

	it('skips when the secret is missing', async () => {
		await env.FERMI_DB.prepare('DELETE FROM secrets').run()
		await fireQueueHook(testEnv, task, [0])
		expect(fetchStub).not.toHaveBeenCalled()
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it('skips when the host is not approved for the secret', async () => {
		await storeSecret(['other.example.com'])
		await fireQueueHook(testEnv, task, [0])
		expect(fetchStub).not.toHaveBeenCalled()
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it('never rejects on unusable config', async () => {
		await env.FERMI_KV.put('queue:hooks', 'not json')
		await expect(fireQueueHook(testEnv, task, [0])).resolves.toBeUndefined()
		await configure({ ...hook, url: 'not a url' })
		await expect(fireQueueHook(testEnv, task, [0])).resolves.toBeUndefined()
		expect(fetchStub).not.toHaveBeenCalled()
	})
})
