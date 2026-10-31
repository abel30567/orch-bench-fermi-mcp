import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUEUE_HOOKS_KEY, fireQueueHook } from '../src/lib/queue-hooks.ts'
import { putSecret } from '../src/lib/secrets-store.ts'
import { enqueueTask } from '../src/lib/task-store.ts'
import { clearSecrets, clearTasks, setupSecretsSchema, setupTasksSchema } from './setup-d1.ts'

const HOOK_ORIGIN = 'https://grok.example.com'
const HOOK_URL = `${HOOK_ORIGIN}/routine/wake`
const SECRET_VALUE = 'super-secret-key-123'
const testEnv = env as unknown as Env

async function configureHook(cfg: Record<string, unknown> = {}) {
	await env.FERMI_KV.put(
		QUEUE_HOOKS_KEY,
		JSON.stringify({
			'grok-bot': {
				url: HOOK_URL,
				auth_header: 'x-grok-key',
				secret: 'GROKBOT_WEBHOOK_KEY',
				...cfg,
			},
		}),
	)
}

async function storeSecret(allowedHosts = ['grok.example.com']) {
	await putSecret(
		{ name: 'GROKBOT_WEBHOOK_KEY', value: SECRET_VALUE, scope: 'app', allowedHosts },
		testEnv,
	)
}

type Captured = { headers: Record<string, string>; body: unknown }

function interceptHook(status: number, captured: Captured[], times = 1) {
	fetchMock
		.get(HOOK_ORIGIN)
		.intercept({ path: '/routine/wake', method: 'POST' })
		.reply((opts) => {
			captured.push({
				headers: opts.headers as Record<string, string>,
				body: JSON.parse(String(opts.body)),
			})
			return { statusCode: status, data: '' }
		})
		.times(times)
}

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
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('fireQueueHook', () => {
	it('is a no-op when no hook is configured', async () => {
		// disableNetConnect: any attempted fetch would throw / be logged as a failure
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, [0])
		expect(res).toEqual({ fired: false, reason: 'not_configured' })
	})

	it('is a no-op for queues without a hook entry', async () => {
		await configureHook()
		await storeSecret()
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'main' }, [0])
		expect(res).toEqual({ fired: false, reason: 'not_configured' })
	})

	it('POSTs {task_id, queue} once with the secret-backed auth header', async () => {
		await configureHook()
		await storeSecret()
		const captured: Captured[] = []
		interceptHook(200, captured)
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, [0, 0, 0])
		expect(res).toMatchObject({ fired: true, ok: true, attempts: 1 })
		expect(captured).toHaveLength(1)
		expect(captured[0].body).toEqual({ task_id: 't1', queue: 'grok-bot' })
		expect(captured[0].headers['x-grok-key']).toBe(SECRET_VALUE)
	})

	it('skips when the secret is missing', async () => {
		await configureHook()
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, [0])
		expect(res).toEqual({ fired: false, reason: 'secret_not_found' })
	})

	it('skips when the URL host is not in the secret allowed hosts', async () => {
		await configureHook()
		await storeSecret(['other.example.com'])
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, [0])
		expect(res).toEqual({ fired: false, reason: 'host_not_approved' })
	})

	it('retries 5xx and 429 within the bounded delays, then succeeds', async () => {
		await configureHook()
		await storeSecret()
		const captured: Captured[] = []
		interceptHook(503, captured)
		interceptHook(429, captured)
		interceptHook(200, captured)
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, [0, 1, 1])
		expect(res).toMatchObject({ fired: true, ok: true, attempts: 3 })
		expect(captured).toHaveLength(3)
	})

	it('gives up after the last attempt without throwing, and never logs the secret', async () => {
		await configureHook()
		await storeSecret()
		const logs: string[] = []
		vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.join(' ')))
		vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')))
		const captured: Captured[] = []
		interceptHook(500, captured, 2)
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, [0, 1])
		expect(res).toMatchObject({ fired: true, ok: false, attempts: 2, status: 500 })
		expect(captured).toHaveLength(2)
		expect(logs.length).toBeGreaterThan(0)
		expect(logs.join('\n')).not.toContain(SECRET_VALUE)
	})

	it('does not retry other 4xx statuses', async () => {
		await configureHook()
		await storeSecret()
		const captured: Captured[] = []
		interceptHook(401, captured)
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, [0, 0, 0])
		expect(res).toMatchObject({ fired: true, ok: false, attempts: 1, status: 401 })
		expect(captured).toHaveLength(1)
	})

	it('treats network errors as retryable and never throws', async () => {
		await configureHook()
		await storeSecret()
		// No interceptor + disableNetConnect → every fetch rejects
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, [0, 1])
		expect(res).toMatchObject({ fired: true, ok: false, attempts: 2 })
	})
})

describe('enqueueTask wake hook', () => {
	it('fires via waitUntil and keeps the secret out of the task payload', async () => {
		await configureHook()
		await storeSecret()
		const captured: Captured[] = []
		interceptHook(200, captured)
		const pending: Promise<unknown>[] = []
		const created = await enqueueTask(
			env.FERMI_DB,
			{ channel: 'cloud', sender: 'cc', chatId: 'cc', payload: '{"v":1}', queue: 'grok-bot' },
			{ env: testEnv, waitUntil: (p) => pending.push(p) },
		)
		expect(pending).toHaveLength(1)
		await Promise.all(pending)
		expect(captured).toHaveLength(1)
		expect(captured[0].body).toEqual({ task_id: created.id, queue: 'grok-bot' })
		const row = await env.FERMI_DB.prepare('SELECT payload FROM tasks WHERE id = ?1')
			.bind(created.id)
			.first<{ payload: string }>()
		expect(row?.payload).not.toContain(SECRET_VALUE)
	})

	it('enqueue succeeds even when the hook fails', async () => {
		await configureHook()
		await storeSecret()
		interceptHook(400, [])
		const pending: Promise<unknown>[] = []
		const created = await enqueueTask(
			env.FERMI_DB,
			{ channel: 'cloud', sender: 'cc', chatId: 'cc', payload: 'x', queue: 'grok-bot' },
			{ env: testEnv, waitUntil: (p) => pending.push(p) },
		)
		expect(created.id).toBeTruthy()
		await expect(Promise.all(pending)).resolves.toBeDefined()
	})
})
