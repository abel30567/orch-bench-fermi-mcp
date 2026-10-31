import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUEUE_HOOKS_KEY, fireQueueHook } from '../src/lib/queue-hooks.ts'
import { putSecret } from '../src/lib/secrets-store.ts'
import { enqueueTask } from '../src/lib/task-store.ts'
import { clearSecrets, clearTasks, setupSecretsSchema, setupTasksSchema } from './setup-d1.ts'

const workerEnv = env as unknown as Env
const HOOK_ORIGIN = 'https://grokbot.example.com'
const SECRET_VALUE = 'grok-super-secret-value'

async function configure(url = `${HOOK_ORIGIN}/routine/wake`) {
	await env.FERMI_KV.put(
		QUEUE_HOOKS_KEY,
		JSON.stringify({
			'grok-bot': { url, auth_header: 'x-api-key', secret: 'GROKBOT_WEBHOOK_KEY' },
		}),
	)
}

async function storeSecret(allowedHosts = ['grokbot.example.com']) {
	await putSecret(
		{ name: 'GROKBOT_WEBHOOK_KEY', value: SECRET_VALUE, scope: 'app', allowedHosts },
		workerEnv,
	)
}

type Seen = { body: string; key: string | undefined }

function intercept(status: number, seen: Seen[], times = 1) {
	fetchMock
		.get(HOOK_ORIGIN)
		.intercept({ path: '/routine/wake', method: 'POST' })
		.reply(status, (opts) => {
			const headers = opts.headers as Record<string, string>
			seen.push({ body: String(opts.body), key: headers['x-api-key'] })
			return 'ok'
		})
		.times(times)
}

describe('fireQueueHook', () => {
	let logs: string[]
	beforeAll(async () => {
		await setupSecretsSchema()
		await setupTasksSchema()
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	beforeEach(async () => {
		await clearSecrets()
		await clearTasks()
		await env.FERMI_KV.delete(QUEUE_HOOKS_KEY)
		logs = []
		const capture = (...args: unknown[]) => logs.push(args.map(String).join(' '))
		vi.spyOn(console, 'warn').mockImplementation(capture)
		vi.spyOn(console, 'log').mockImplementation(capture)
		vi.spyOn(console, 'error').mockImplementation(capture)
	})
	afterEach(() => {
		vi.restoreAllMocks()
		fetchMock.assertNoPendingInterceptors()
	})

	it('no config → no-op (no fetch)', async () => {
		await storeSecret()
		expect(await fireQueueHook(workerEnv, { task_id: 't1', queue: 'grok-bot' })).toEqual({
			fired: false,
			reason: 'not_configured',
		})
	})

	it('configured queue but missing secret → no-op', async () => {
		await configure()
		expect(await fireQueueHook(workerEnv, { task_id: 't1', queue: 'grok-bot' })).toEqual({
			fired: false,
			reason: 'secret_missing',
		})
	})

	it('host not in the secret allowed_hosts → skipped', async () => {
		await configure()
		await storeSecret(['other.example.com'])
		expect(await fireQueueHook(workerEnv, { task_id: 't1', queue: 'grok-bot' })).toEqual({
			fired: false,
			reason: 'host_not_approved',
		})
	})

	it('other queues are not hooked', async () => {
		await configure()
		await storeSecret()
		const out = await fireQueueHook(workerEnv, { task_id: 't1', queue: 'main' })
		expect(out).toEqual({ fired: false, reason: 'not_configured' })
	})

	it('POSTs {task_id, queue} once with the secret-backed auth header', async () => {
		await configure()
		await storeSecret()
		const seen: Seen[] = []
		intercept(200, seen)
		const out = await fireQueueHook(workerEnv, { task_id: 't1', queue: 'grok-bot' }, [0, 0, 0])
		expect(out).toEqual({ fired: true, ok: true, attempts: 1, status: 200 })
		expect(seen).toHaveLength(1)
		expect(JSON.parse(seen[0].body)).toEqual({ task_id: 't1', queue: 'grok-bot' })
		expect(seen[0].key).toBe(SECRET_VALUE)
	})

	it('retries 5xx and 429, bounded by delaysMs, and logs without the secret', async () => {
		await configure()
		await storeSecret()
		const seen: Seen[] = []
		intercept(503, seen)
		intercept(429, seen)
		intercept(500, seen)
		const out = await fireQueueHook(workerEnv, { task_id: 't2', queue: 'grok-bot' }, [0, 1, 1])
		expect(out).toEqual({ fired: true, ok: false, attempts: 3, status: 500 })
		expect(seen).toHaveLength(3)
		expect(logs.some((l) => l.includes('gave up after 3 attempts'))).toBe(true)
		expect(logs.join('\n')).not.toContain(SECRET_VALUE)
	})

	it('recovers on a later attempt', async () => {
		await configure()
		await storeSecret()
		const seen: Seen[] = []
		intercept(502, seen)
		intercept(200, seen)
		const out = await fireQueueHook(workerEnv, { task_id: 't3', queue: 'grok-bot' }, [0, 1, 1])
		expect(out).toEqual({ fired: true, ok: true, attempts: 2, status: 200 })
	})

	it('non-retryable status stops after one attempt', async () => {
		await configure()
		await storeSecret()
		const seen: Seen[] = []
		intercept(401, seen)
		const out = await fireQueueHook(workerEnv, { task_id: 't4', queue: 'grok-bot' }, [0, 1, 1])
		expect(out).toEqual({ fired: true, ok: false, attempts: 1, status: 401 })
		expect(seen).toHaveLength(1)
	})

	it('redirects are not followed and not retried (secret never leaves the approved host)', async () => {
		await configure()
		await storeSecret()
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		fetchMock
			.get(HOOK_ORIGIN)
			.intercept({ path: '/routine/wake', method: 'POST' })
			.reply(307, '', { headers: { location: 'https://evil.example.net/steal' } })
		const out = await fireQueueHook(workerEnv, { task_id: 't7', queue: 'grok-bot' }, [0, 1, 1])
		expect(out).toEqual({ fired: true, ok: false, attempts: 1, status: 307 })
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect((fetchSpy.mock.calls[0][1] as RequestInit).redirect).toBe('manual')
		expect(logs.some((l) => l.includes('not following'))).toBe(true)
	})

	it('network errors are retried and never throw', async () => {
		await configure()
		await storeSecret()
		fetchMock
			.get(HOOK_ORIGIN)
			.intercept({ path: '/routine/wake', method: 'POST' })
			.replyWithError(new Error('boom'))
			.times(2)
		const out = await fireQueueHook(workerEnv, { task_id: 't5', queue: 'grok-bot' }, [0, 1])
		expect(out).toEqual({ fired: true, ok: false, attempts: 2, status: undefined })
	})

	it('invalid KV config → no-op', async () => {
		await env.FERMI_KV.put(QUEUE_HOOKS_KEY, '{not json')
		const out = await fireQueueHook(workerEnv, { task_id: 't6', queue: 'grok-bot' })
		expect(out).toEqual({ fired: false, reason: 'not_configured' })
	})

	describe('via enqueueTask', () => {
		it('fires one hook through waitUntil and keeps the secret out of the payload', async () => {
			await configure()
			await storeSecret()
			const seen: Seen[] = []
			intercept(200, seen)
			const pending: Promise<unknown>[] = []
			const created = await enqueueTask(
				env.FERMI_DB,
				{ channel: 'cloud', sender: 'claude', chatId: 'c', payload: '{"v":1}', queue: 'grok-bot' },
				{ env: workerEnv, waitUntil: (p) => pending.push(p) },
			)
			expect(pending).toHaveLength(1)
			await Promise.all(pending)
			expect(seen).toHaveLength(1)
			expect(JSON.parse(seen[0].body)).toEqual({ task_id: created.id, queue: 'grok-bot' })
			const row = await env.FERMI_DB.prepare('SELECT payload FROM tasks WHERE id = ?1')
				.bind(created.id)
				.first<{ payload: string }>()
			expect(row?.payload).toBe('{"v":1}')
		})

		it('a failing hook never fails the enqueue', async () => {
			await configure()
			await storeSecret()
			const seen: Seen[] = []
			intercept(401, seen)
			const pending: Promise<unknown>[] = []
			const created = await enqueueTask(
				env.FERMI_DB,
				{ channel: 'cloud', sender: 'claude', chatId: 'c', payload: 'x', queue: 'grok-bot' },
				{ env: workerEnv, waitUntil: (p) => pending.push(p) },
			)
			expect(created.id).toBeTruthy()
			// enqueue returned before the hook settled; the hook resolves (never rejects)
			await expect(Promise.all(pending)).resolves.toBeDefined()
			expect(seen).toHaveLength(1)
		})
	})
})
