import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUEUE_HOOKS_KV_KEY, fireQueueHook } from '../src/lib/queue-hooks.ts'
import { putSecret } from '../src/lib/secrets-store.ts'
import { enqueueTask, listTasks } from '../src/lib/task-store.ts'
import { clearSecrets, clearTasks, setupSecretsSchema, setupTasksSchema } from './setup-d1.ts'

const workerEnv = env as unknown as Env
const HOOK_ORIGIN = 'https://grokbot.example.com'
const SECRET_VALUE = 'sk-grok-super-secret-value'
const NO_DELAY = [0, 0, 0]

async function configure() {
	await env.FERMI_KV.put(
		QUEUE_HOOKS_KV_KEY,
		JSON.stringify({
			'grok-bot': {
				url: `${HOOK_ORIGIN}/routine/wake`,
				auth_header: 'x-api-key',
				secret: 'GROKBOT_WEBHOOK_KEY',
			},
		}),
	)
	await putSecret(
		{
			name: 'GROKBOT_WEBHOOK_KEY',
			value: SECRET_VALUE,
			scope: 'app',
			allowedHosts: ['grokbot.example.com'],
		},
		workerEnv,
	)
}

function captureRequests(statuses: number[]) {
	const seen: Array<{ body: unknown; headers: Record<string, string> }> = []
	for (const status of statuses) {
		fetchMock
			.get(HOOK_ORIGIN)
			.intercept({ path: '/routine/wake', method: 'POST' })
			.reply((opts) => {
				seen.push({
					body: JSON.parse(String(opts.body)),
					headers: opts.headers as Record<string, string>,
				})
				return { statusCode: status, data: '' }
			})
	}
	return seen
}

describe('fireQueueHook', () => {
	let warn: ReturnType<typeof vi.spyOn>

	beforeAll(async () => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
		await setupSecretsSchema()
		await setupTasksSchema()
	})

	beforeEach(async () => {
		await env.FERMI_KV.delete(QUEUE_HOOKS_KV_KEY)
		await clearSecrets()
		await clearTasks()
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	})

	afterEach(() => {
		warn.mockRestore()
		fetchMock.assertNoPendingInterceptors()
	})

	function logged(): string {
		return warn.mock.calls.map((c) => c.join(' ')).join('\n')
	}

	it('is a no-op when no hook is configured', async () => {
		// disableNetConnect makes any fetch throw; the result shows none was attempted
		const r = await fireQueueHook(workerEnv, { task_id: 't1', queue: 'grok-bot' }, NO_DELAY)
		expect(r).toEqual({ fired: false, reason: 'not_configured' })
	})

	it('is a no-op when the queue is not in the config', async () => {
		await configure()
		const r = await fireQueueHook(workerEnv, { task_id: 't1', queue: 'main' }, NO_DELAY)
		expect(r).toEqual({ fired: false, reason: 'not_configured' })
	})

	it('skips when the secret is missing', async () => {
		await configure()
		await clearSecrets()
		const r = await fireQueueHook(workerEnv, { task_id: 't1', queue: 'grok-bot' }, NO_DELAY)
		expect(r).toEqual({ fired: false, reason: 'secret_not_found' })
	})

	it('skips when the URL host is not in the secret’s allowed hosts', async () => {
		await configure()
		await putSecret(
			{ name: 'GROKBOT_WEBHOOK_KEY', value: SECRET_VALUE, scope: 'app', allowedHosts: ['x.com'] },
			workerEnv,
		)
		const r = await fireQueueHook(workerEnv, { task_id: 't1', queue: 'grok-bot' }, NO_DELAY)
		expect(r).toEqual({ fired: false, reason: 'host_not_approved' })
	})

	it('POSTs {task_id, queue} once with the secret-backed auth header', async () => {
		await configure()
		const seen = captureRequests([200])
		const r = await fireQueueHook(workerEnv, { task_id: 't1', queue: 'grok-bot' }, NO_DELAY)
		expect(r).toEqual({ fired: true, ok: true, attempts: 1, status: 200 })
		expect(seen).toHaveLength(1)
		expect(seen[0].body).toEqual({ task_id: 't1', queue: 'grok-bot' })
		expect(seen[0].headers['x-api-key']).toBe(SECRET_VALUE)
	})

	it('retries 5xx and 429 within the bounded delays, then succeeds', async () => {
		await configure()
		const seen = captureRequests([503, 429, 200])
		const r = await fireQueueHook(workerEnv, { task_id: 't1', queue: 'grok-bot' }, NO_DELAY)
		expect(r).toEqual({ fired: true, ok: true, attempts: 3, status: 200 })
		expect(seen).toHaveLength(3)
		expect(logged()).toContain('attempt 1 got 503')
		expect(logged()).not.toContain(SECRET_VALUE)
	})

	it('gives up after delaysMs.length attempts and logs it', async () => {
		await configure()
		captureRequests([500, 500])
		const r = await fireQueueHook(workerEnv, { task_id: 't1', queue: 'grok-bot' }, [0, 0])
		expect(r).toEqual({ fired: true, ok: false, attempts: 2, status: 500 })
		expect(logged()).toContain('gave up after 2 attempts')
		expect(logged()).not.toContain(SECRET_VALUE)
	})

	it('does not retry other 4xx statuses', async () => {
		await configure()
		const seen = captureRequests([401])
		const r = await fireQueueHook(workerEnv, { task_id: 't1', queue: 'grok-bot' }, NO_DELAY)
		expect(r).toEqual({ fired: true, ok: false, attempts: 1, status: 401 })
		expect(seen).toHaveLength(1)
	})

	it('retries network errors', async () => {
		await configure()
		fetchMock
			.get(HOOK_ORIGIN)
			.intercept({ path: '/routine/wake', method: 'POST' })
			.replyWithError(new Error('boom'))
		captureRequests([200])
		const r = await fireQueueHook(workerEnv, { task_id: 't1', queue: 'grok-bot' }, [0, 0])
		expect(r).toEqual({ fired: true, ok: true, attempts: 2, status: 200 })
		expect(logged()).toContain('attempt 1 failed')
	})

	describe('via enqueueTask', () => {
		it('fires once on enqueue to a configured queue, payload untouched', async () => {
			await configure()
			const seen = captureRequests([200])
			const pending: Promise<unknown>[] = []
			const task = await enqueueTask(
				env.FERMI_DB,
				{ channel: 'cloud', sender: 'cc', chatId: 'c', payload: '{"v":1}', queue: 'grok-bot' },
				{ env: workerEnv, waitUntil: (p) => pending.push(p) },
			)
			expect(pending).toHaveLength(1)
			await Promise.all(pending)
			expect(seen).toEqual([
				expect.objectContaining({ body: { task_id: task.id, queue: 'grok-bot' } }),
			])
			const [row] = await listTasks(env.FERMI_DB, { queue: 'grok-bot' })
			expect(row.payload).toBe('{"v":1}')
			expect(JSON.stringify(row)).not.toContain(SECRET_VALUE)
		})

		it('enqueue succeeds even when every hook attempt fails', async () => {
			await configure()
			fetchMock
				.get(HOOK_ORIGIN)
				.intercept({ path: '/routine/wake', method: 'POST' })
				.replyWithError(new Error('down'))
				.times(3)
			const pending: Promise<unknown>[] = []
			const task = await enqueueTask(
				env.FERMI_DB,
				{ channel: 'cloud', sender: 'cc', chatId: 'c', payload: 'p', queue: 'grok-bot' },
				{ env: workerEnv, waitUntil: (p) => pending.push(p) },
			)
			expect(task.id).toBeTruthy()
			// Default delays are real (0/2s/8s); the enqueue already returned above.
			const [row] = await listTasks(env.FERMI_DB, { queue: 'grok-bot' })
			expect(row.status).toBe('pending')
			await expect(Promise.all(pending)).resolves.toBeDefined()
		}, 20_000)
	})
})
