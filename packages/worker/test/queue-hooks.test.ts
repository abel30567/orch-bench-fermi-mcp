import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUEUE_HOOKS_KV_KEY, fireQueueHook } from '../src/lib/queue-hooks.ts'
import { putSecret } from '../src/lib/secrets-store.ts'
import { enqueueTask } from '../src/lib/task-store.ts'
import { clearSecrets, clearTasks, setupSecretsSchema, setupTasksSchema } from './setup-d1.ts'

const HOOK_ORIGIN = 'https://grok.example.com'
const HOOK_HOST = 'grok.example.com'
const SECRET_VALUE = 'super-secret-grok-key'
const testEnv = env as unknown as Env
const NO_WAIT = [0, 0, 0]

async function configure(map: Record<string, unknown>) {
	await env.FERMI_KV.put(QUEUE_HOOKS_KV_KEY, JSON.stringify(map))
}

async function storeSecret(allowedHosts = [HOOK_HOST]) {
	await putSecret(
		{ name: 'GROKBOT_WEBHOOK_KEY', value: SECRET_VALUE, scope: 'app', allowedHosts },
		testEnv,
	)
}

const GROK_HOOK = {
	'grok-bot': {
		url: `${HOOK_ORIGIN}/routine/wake`,
		auth_header: 'x-routine-key',
		secret: 'GROKBOT_WEBHOOK_KEY',
	},
}

function interceptWake(status: number, times = 1) {
	const seen: Array<{ body: unknown; headers: Record<string, string> }> = []
	fetchMock
		.get(HOOK_ORIGIN)
		.intercept({ path: '/routine/wake', method: 'POST' })
		.reply(status, (opts) => {
			seen.push({
				body: JSON.parse(String(opts.body)),
				headers: opts.headers as Record<string, string>,
			})
			return {}
		})
		.times(times)
	return seen
}

beforeAll(async () => {
	await setupSecretsSchema()
	await setupTasksSchema()
	fetchMock.activate()
	fetchMock.disableNetConnect()
})

let logs: string[]
beforeEach(async () => {
	await env.FERMI_KV.delete(QUEUE_HOOKS_KV_KEY)
	await clearSecrets()
	await clearTasks()
	logs = []
	vi.spyOn(console, 'log').mockImplementation((...args) => {
		logs.push(args.join(' '))
	})
})

afterEach(() => {
	vi.restoreAllMocks()
	fetchMock.assertNoPendingInterceptors()
})

describe('fireQueueHook', () => {
	it('is a no-op when nothing is configured', async () => {
		// disableNetConnect makes any attempted fetch throw
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, NO_WAIT)
		expect(res).toEqual({ fired: false, attempts: 0, skipped: 'no_config' })
	})

	it('is a no-op for queues without a hook', async () => {
		await configure(GROK_HOOK)
		await storeSecret()
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'main' }, NO_WAIT)
		expect(res.skipped).toBe('no_config')
	})

	it('skips when the secret is missing', async () => {
		await configure(GROK_HOOK)
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, NO_WAIT)
		expect(res).toMatchObject({ fired: false, attempts: 0, skipped: 'secret_missing' })
	})

	it('skips when the URL host is not in the secret allowed hosts', async () => {
		await configure(GROK_HOOK)
		await storeSecret(['other.example.com'])
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, NO_WAIT)
		expect(res).toMatchObject({ fired: false, attempts: 0, skipped: 'host_not_approved' })
	})

	it('skips malformed config', async () => {
		await env.FERMI_KV.put(QUEUE_HOOKS_KV_KEY, '{not json')
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, NO_WAIT)
		expect(res.skipped).toBe('bad_config')
	})

	it('POSTs {task_id, queue} once with the secret-backed auth header', async () => {
		await configure(GROK_HOOK)
		await storeSecret()
		const seen = interceptWake(200)
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, NO_WAIT)
		expect(res).toEqual({ fired: true, attempts: 1, status: 200 })
		expect(seen).toHaveLength(1)
		expect(seen[0].body).toEqual({ task_id: 't1', queue: 'grok-bot' })
		expect(seen[0].headers['x-routine-key']).toBe(SECRET_VALUE)
		expect(logs.join('\n')).not.toContain(SECRET_VALUE)
	})

	it('retries 5xx and 429, then succeeds', async () => {
		await configure(GROK_HOOK)
		await storeSecret()
		interceptWake(503)
		interceptWake(429)
		interceptWake(200)
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, NO_WAIT)
		expect(res).toEqual({ fired: true, attempts: 3, status: 200 })
	})

	it('gives up after one attempt per delay and logs it', async () => {
		await configure(GROK_HOOK)
		await storeSecret()
		interceptWake(500, 2)
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, [0, 0])
		expect(res).toEqual({ fired: false, attempts: 2, status: 500, error: undefined })
		expect(logs.some((l) => l.includes('gave_up'))).toBe(true)
		expect(logs.join('\n')).not.toContain(SECRET_VALUE)
	})

	it('does not retry other 4xx', async () => {
		await configure(GROK_HOOK)
		await storeSecret()
		interceptWake(401)
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, NO_WAIT)
		expect(res).toEqual({ fired: false, attempts: 1, status: 401 })
	})

	it('retries network errors', async () => {
		await configure(GROK_HOOK)
		await storeSecret()
		fetchMock
			.get(HOOK_ORIGIN)
			.intercept({ path: '/routine/wake', method: 'POST' })
			.replyWithError(new Error('boom'))
		interceptWake(200)
		const res = await fireQueueHook(testEnv, { task_id: 't1', queue: 'grok-bot' }, NO_WAIT)
		expect(res).toEqual({ fired: true, attempts: 2, status: 200 })
	})
})

describe('enqueueTask with a hook context', () => {
	it('fires the hook in waitUntil with the new task id', async () => {
		await configure(GROK_HOOK)
		await storeSecret()
		const seen = interceptWake(200)
		const pending: Promise<unknown>[] = []
		const task = await enqueueTask(
			env.FERMI_DB,
			{ channel: 'cloud', sender: 's', chatId: 'cloud', payload: '{"v":1}', queue: 'grok-bot' },
			{ env: testEnv, waitUntil: (p) => pending.push(p) },
		)
		expect(pending).toHaveLength(1)
		await Promise.all(pending)
		expect(seen).toEqual([
			expect.objectContaining({ body: { task_id: task.id, queue: 'grok-bot' } }),
		])
		const row = await env.FERMI_DB.prepare('SELECT payload FROM tasks WHERE id = ?1')
			.bind(task.id)
			.first<{ payload: string }>()
		expect(row?.payload).not.toContain(SECRET_VALUE)
	})

	it('never fails the enqueue when the hook fails', async () => {
		await configure(GROK_HOOK)
		await storeSecret()
		// Every attempt hits a refused connection (no interceptor + disableNetConnect).
		const pending: Promise<unknown>[] = []
		const task = await enqueueTask(
			env.FERMI_DB,
			{ channel: 'cloud', sender: 's', chatId: 'cloud', payload: '{}', queue: 'grok-bot' },
			{ env: testEnv, waitUntil: (p) => pending.push(p) },
		)
		expect(task.id).toBeTruthy()
		await expect(Promise.all(pending)).resolves.toBeDefined()
		const row = await env.FERMI_DB.prepare('SELECT status FROM tasks WHERE id = ?1')
			.bind(task.id)
			.first<{ status: string }>()
		expect(row?.status).toBe('pending')
	}, 15_000)
})
