import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUEUE_HOOKS_KV_KEY, fireQueueHook } from '../src/lib/queue-hooks.ts'
import { putSecret } from '../src/lib/secrets-store.ts'
import { enqueueTask } from '../src/lib/task-store.ts'
import { clearSecrets, clearTasks, setupSecretsSchema, setupTasksSchema } from './setup-d1.ts'

const HOOK_ORIGIN = 'https://hooks.grok.example'
const SECRET_VALUE = 'sk-grok-super-secret'
const e = env as unknown as Env

async function configure() {
	await env.FERMI_KV.put(
		QUEUE_HOOKS_KV_KEY,
		JSON.stringify({
			'grok-bot': {
				url: `${HOOK_ORIGIN}/routine/wake`,
				auth_header: 'x-grokbot-key',
				secret: 'GROKBOT_WEBHOOK_KEY',
			},
		}),
	)
	await putSecret(
		{
			name: 'GROKBOT_WEBHOOK_KEY',
			value: SECRET_VALUE,
			scope: 'app',
			allowedHosts: ['hooks.grok.example'],
		},
		e,
	)
}

type Captured = { body: unknown; auth: string | undefined }

function intercept(status: number, captured: Captured[], times = 1) {
	fetchMock
		.get(HOOK_ORIGIN)
		.intercept({ path: '/routine/wake', method: 'POST' })
		.reply(status, (opts) => {
			const h = opts.headers as Record<string, string> | Headers
			const auth = h instanceof Headers ? (h.get('x-grokbot-key') ?? undefined) : h['x-grokbot-key']
			captured.push({ body: JSON.parse(String(opts.body)), auth })
			return {}
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
	await env.FERMI_KV.delete(QUEUE_HOOKS_KV_KEY)
	await clearSecrets()
	await clearTasks()
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('fireQueueHook', () => {
	it('is a no-op when no hook is configured', async () => {
		const out = await fireQueueHook(e, { task_id: 't1', queue: 'grok-bot' }, [0])
		expect(out).toEqual({ fired: false, reason: 'not_configured' })
	})

	it('is a no-op for queues without a hook', async () => {
		await configure()
		const out = await fireQueueHook(e, { task_id: 't1', queue: 'main' }, [0])
		expect(out.fired).toBe(false)
	})

	it('skips when the secret is missing', async () => {
		await configure()
		await clearSecrets()
		const out = await fireQueueHook(e, { task_id: 't1', queue: 'grok-bot' }, [0])
		expect(out).toEqual({ fired: false, reason: 'secret_missing' })
	})

	it("skips when the URL host is not in the secret's allowed hosts", async () => {
		await configure()
		await putSecret(
			{ name: 'GROKBOT_WEBHOOK_KEY', value: SECRET_VALUE, scope: 'app', allowedHosts: ['x.com'] },
			e,
		)
		const out = await fireQueueHook(e, { task_id: 't1', queue: 'grok-bot' }, [0])
		expect(out).toEqual({ fired: false, reason: 'host_not_approved' })
	})

	it('POSTs {task_id, queue} once with the secret-backed auth header', async () => {
		await configure()
		const captured: Captured[] = []
		intercept(200, captured)
		const out = await fireQueueHook(e, { task_id: 't1', queue: 'grok-bot' }, [0, 0, 0])
		expect(out).toEqual({ fired: true, ok: true, attempts: 1, status: 200 })
		expect(captured).toEqual([{ body: { task_id: 't1', queue: 'grok-bot' }, auth: SECRET_VALUE }])
	})

	it('retries on 5xx/429 up to the bounded attempt count, never logging the secret', async () => {
		await configure()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const captured: Captured[] = []
		intercept(503, captured)
		intercept(429, captured)
		intercept(500, captured)
		const out = await fireQueueHook(e, { task_id: 't2', queue: 'grok-bot' }, [0, 1, 1])
		expect(out).toEqual({ fired: true, ok: false, attempts: 3, status: 500 })
		expect(captured).toHaveLength(3)
		expect(warn).toHaveBeenCalled()
		for (const call of warn.mock.calls) expect(String(call.join(' '))).not.toContain(SECRET_VALUE)
	})

	it('retries after a 5xx then succeeds', async () => {
		await configure()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const captured: Captured[] = []
		intercept(502, captured)
		intercept(202, captured)
		const out = await fireQueueHook(e, { task_id: 't3', queue: 'grok-bot' }, [0, 1, 1])
		expect(out).toEqual({ fired: true, ok: true, attempts: 2, status: 202 })
	})

	it('stops on non-retryable 4xx', async () => {
		await configure()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const captured: Captured[] = []
		intercept(401, captured)
		const out = await fireQueueHook(e, { task_id: 't4', queue: 'grok-bot' }, [0, 1, 1])
		expect(out).toEqual({ fired: true, ok: false, attempts: 1, status: 401 })
		expect(captured).toHaveLength(1)
	})

	it('retries network errors and gives up without throwing', async () => {
		await configure()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		fetchMock
			.get(HOOK_ORIGIN)
			.intercept({ path: '/routine/wake', method: 'POST' })
			.replyWithError(new Error('boom'))
			.times(2)
		const out = await fireQueueHook(e, { task_id: 't5', queue: 'grok-bot' }, [0, 1])
		expect(out).toEqual({ fired: true, ok: false, attempts: 2, status: undefined })
	})
})

describe('enqueueTask wake hook', () => {
	it('fires the hook via waitUntil and never fails the enqueue', async () => {
		await configure()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const pending: Promise<unknown>[] = []
		const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
		const captured: Captured[] = []
		intercept(200, captured)
		const task = await enqueueTask(
			env.FERMI_DB,
			{ channel: 'cloud', sender: 's', chatId: 'cloud', payload: '{"v":1}', queue: 'grok-bot' },
			{ env: e, ctx },
		)
		expect(task.id).toBeTruthy()
		expect(pending).toHaveLength(1)
		await Promise.all(pending)
		expect(captured).toEqual([
			{ body: { task_id: task.id, queue: 'grok-bot' }, auth: SECRET_VALUE },
		])
		const row = await env.FERMI_DB.prepare('SELECT payload FROM tasks WHERE id = ?1')
			.bind(task.id)
			.first<{ payload: string }>()
		expect(row?.payload).not.toContain(SECRET_VALUE)
	})

	it('enqueue succeeds when the hook keeps failing', async () => {
		await configure()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const pending: Promise<unknown>[] = []
		const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
		await env.FERMI_KV.put(QUEUE_HOOKS_KV_KEY, 'not json')
		const task = await enqueueTask(
			env.FERMI_DB,
			{ channel: 'cloud', sender: 's', chatId: 'cloud', payload: 'x', queue: 'grok-bot' },
			{ env: e, ctx },
		)
		expect(task.id).toBeTruthy()
		await Promise.all(pending)
	})
})
