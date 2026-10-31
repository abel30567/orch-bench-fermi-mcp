import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUEUE_HOOKS_KV_KEY, fireQueueHook } from '../src/lib/queue-hooks.ts'
import { putSecret } from '../src/lib/secrets-store.ts'
import { enqueueTask, listTasks } from '../src/lib/task-store.ts'
import { clearSecrets, clearTasks, setupSecretsSchema, setupTasksSchema } from './setup-d1.ts'

const ORIGIN = 'https://grok.example.com'
const SECRET_VALUE = 'gk-super-secret-value'
const e = env as unknown as Env

async function configure() {
	await env.FERMI_KV.put(
		QUEUE_HOOKS_KV_KEY,
		JSON.stringify({
			'grok-bot': {
				url: `${ORIGIN}/hook`,
				auth_header: 'x-api-key',
				secret: 'GROKBOT_WEBHOOK_KEY',
			},
		}),
	)
	await putSecret(
		{
			name: 'GROKBOT_WEBHOOK_KEY',
			scope: 'app',
			value: SECRET_VALUE,
			allowedHosts: ['grok.example.com'],
		},
		e,
	)
}

describe('fireQueueHook', () => {
	beforeAll(async () => {
		await setupSecretsSchema()
		await setupTasksSchema()
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})
	beforeEach(async () => {
		await clearSecrets()
		await clearTasks()
		await env.FERMI_KV.delete(QUEUE_HOOKS_KV_KEY)
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('is a no-op when nothing is configured', async () => {
		const res = await fireQueueHook(e, { task_id: 't1', queue: 'grok-bot' }, [0])
		expect(res).toEqual({ fired: false, reason: 'not_configured' })
	})

	it('is a no-op for an unconfigured queue', async () => {
		await configure()
		const res = await fireQueueHook(e, { task_id: 't1', queue: 'main' }, [0])
		expect(res.fired).toBe(false)
	})

	it('POSTs {task_id, queue} with the secret-backed auth header', async () => {
		await configure()
		const seen: Array<{ body: unknown; key: string | null }> = []
		fetchMock
			.get(ORIGIN)
			.intercept({ path: '/hook', method: 'POST' })
			.reply(200, (opts) => {
				const headers = new Headers(opts.headers as HeadersInit)
				seen.push({ body: JSON.parse(String(opts.body)), key: headers.get('x-api-key') })
				return 'ok'
			})
		const res = await fireQueueHook(e, { task_id: 't1', queue: 'grok-bot' }, [0, 0, 0])
		expect(res).toMatchObject({ fired: true, ok: true, attempts: 1 })
		expect(seen).toEqual([{ body: { task_id: 't1', queue: 'grok-bot' }, key: SECRET_VALUE }])
	})

	it('skips when the URL host is not in the secret allowed hosts', async () => {
		await configure()
		await putSecret(
			{ name: 'GROKBOT_WEBHOOK_KEY', scope: 'app', value: SECRET_VALUE, allowedHosts: [] },
			e,
		)
		const res = await fireQueueHook(e, { task_id: 't1', queue: 'grok-bot' }, [0])
		expect(res).toEqual({ fired: false, reason: 'host_not_approved' })
	})

	it('retries 5xx/429 with bounded attempts and never logs the secret', async () => {
		await configure()
		const warn = vi.spyOn(console, 'warn')
		fetchMock.get(ORIGIN).intercept({ path: '/hook', method: 'POST' }).reply(503, 'down')
		fetchMock.get(ORIGIN).intercept({ path: '/hook', method: 'POST' }).reply(429, 'slow')
		fetchMock.get(ORIGIN).intercept({ path: '/hook', method: 'POST' }).reply(500, 'down')
		const res = await fireQueueHook(e, { task_id: 't1', queue: 'grok-bot' }, [0, 0, 0])
		expect(res).toMatchObject({ fired: true, ok: false, attempts: 3, status: 500 })
		expect(warn).toHaveBeenCalled()
		for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET_VALUE)
	})

	it('stops on non-retryable statuses', async () => {
		await configure()
		fetchMock.get(ORIGIN).intercept({ path: '/hook', method: 'POST' }).reply(401, 'no')
		const res = await fireQueueHook(e, { task_id: 't1', queue: 'grok-bot' }, [0, 0, 0])
		expect(res).toMatchObject({ fired: true, ok: false, attempts: 1, status: 401 })
	})

	it('retries network errors', async () => {
		await configure()
		fetchMock
			.get(ORIGIN)
			.intercept({ path: '/hook', method: 'POST' })
			.replyWithError(new Error('boom'))
		fetchMock.get(ORIGIN).intercept({ path: '/hook', method: 'POST' }).reply(200, 'ok')
		const res = await fireQueueHook(e, { task_id: 't1', queue: 'grok-bot' }, [0, 0])
		expect(res).toMatchObject({ fired: true, ok: true, attempts: 2 })
	})

	it('enqueue fires the hook via waitUntil and never fails on hook errors', async () => {
		await configure()
		fetchMock.get(ORIGIN).intercept({ path: '/hook', method: 'POST' }).reply(401, 'nope')
		const pending: Promise<unknown>[] = []
		const created = await enqueueTask(
			env.FERMI_DB,
			{ channel: 'cloud', sender: 's', chatId: 'c', payload: '{}', queue: 'grok-bot' },
			{ env: e, waitUntil: (p) => pending.push(p) },
		)
		expect(pending).toHaveLength(1)
		await Promise.all(pending)
		const tasks = await listTasks(env.FERMI_DB, { queue: 'grok-bot' })
		expect(tasks.map((t) => t.id)).toEqual([created.id])
		expect(tasks[0].payload).not.toContain(SECRET_VALUE)
	})
})
