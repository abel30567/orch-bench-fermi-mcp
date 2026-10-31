import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleTelegramWebhook } from '../src/channels/telegram.ts'
import { addToAllowlist } from '../src/lib/allowlist-store.ts'
import { fireQueueHook } from '../src/lib/queue-hooks.ts'
import { putSecret } from '../src/lib/secrets-store.ts'
import { enqueueTask, listTasks } from '../src/lib/task-store.ts'
import {
	clearAllowlist,
	clearSecrets,
	clearSessions,
	clearTasks,
	setupAllowlistSchema,
	setupSecretsSchema,
	setupSessionsSchema,
	setupTasksSchema,
} from './setup-d1.ts'

const workerEnv = env as unknown as Env

const ORIGIN = 'https://hooks.example.com'
const PATH = '/routine/wake'
const SECRET_VALUE = 'super-secret-webhook-key'
const EVENT = { task_id: 'task-1', queue: 'grok-bot' }
const FAST = [0, 0, 0]

interface Received {
	body: unknown
	auth: string | undefined
}

function headerValue(headers: unknown, name: string): string | undefined {
	return new Headers(headers as HeadersInit).get(name) ?? undefined
}

/** Queue one mocked reply per status; every POST that reaches the mock is recorded. */
function replyWith(received: Received[], ...statuses: number[]) {
	for (const status of statuses) {
		fetchMock
			.get(ORIGIN)
			.intercept({ path: PATH, method: 'POST' })
			.reply(status, (opts) => {
				received.push({
					body: JSON.parse(String(opts.body)),
					auth: headerValue(opts.headers, 'x-routine-key'),
				})
				return ''
			})
	}
}

async function configureHook(queue = 'grok-bot', url = `${ORIGIN}${PATH}`) {
	await env.FERMI_KV.put(
		'queue:hooks',
		JSON.stringify({
			[queue]: { url, auth_header: 'x-routine-key', secret: 'GROKBOT_WEBHOOK_KEY' },
		}),
	)
}

async function storeSecret(allowedHosts = ['hooks.example.com']) {
	await putSecret(
		{ name: 'GROKBOT_WEBHOOK_KEY', value: SECRET_VALUE, scope: 'app', allowedHosts },
		workerEnv,
	)
}

beforeAll(async () => {
	await setupTasksSchema()
	await setupSecretsSchema()
	await setupAllowlistSchema()
	await setupSessionsSchema()
	fetchMock.activate()
	fetchMock.disableNetConnect()
})

beforeEach(async () => {
	await clearTasks()
	await clearSecrets()
	await clearAllowlist()
	await clearSessions()
	await env.FERMI_KV.delete('queue:hooks')
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('fireQueueHook', () => {
	it('POSTs {task_id, queue} once with the secret-backed auth header', async () => {
		await configureHook()
		await storeSecret()
		const received: Received[] = []
		replyWith(received, 200)

		await fireQueueHook(workerEnv, EVENT, FAST)

		expect(received).toEqual([{ body: EVENT, auth: SECRET_VALUE }])
	})

	it('is a no-op without config, for other queues, and for incomplete entries', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		await fireQueueHook(workerEnv, EVENT, FAST)

		await configureHook('other-queue')
		await storeSecret()
		await fireQueueHook(workerEnv, EVENT, FAST)

		await env.FERMI_KV.put('queue:hooks', JSON.stringify({ 'grok-bot': { url: '' } }))
		await fireQueueHook(workerEnv, EVENT, FAST)

		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('skips when the secret is missing', async () => {
		await configureHook()
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		await fireQueueHook(workerEnv, EVENT, FAST)

		expect(fetchSpy).not.toHaveBeenCalled()
		expect(warn.mock.calls[0][1]).toMatchObject({ outcome: 'secret_not_found' })
	})

	it("skips when the URL's host is not in the secret's allowed hosts", async () => {
		await configureHook()
		await storeSecret(['elsewhere.example.com'])
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		await fireQueueHook(workerEnv, EVENT, FAST)

		expect(fetchSpy).not.toHaveBeenCalled()
		expect(warn.mock.calls[0][1]).toMatchObject({ outcome: 'host_not_approved' })
	})

	it('swallows malformed config', async () => {
		await env.FERMI_KV.put('queue:hooks', '{not json')
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		await expect(fireQueueHook(workerEnv, EVENT, FAST)).resolves.toBeUndefined()

		expect(warn.mock.calls[0][1]).toMatchObject({ outcome: 'failed' })
	})

	it('retries 429 and 5xx, then stops on success', async () => {
		await configureHook()
		await storeSecret()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const received: Received[] = []
		replyWith(received, 429, 503, 200)

		await fireQueueHook(workerEnv, EVENT, FAST)

		expect(received).toHaveLength(3)
	})

	it('makes one attempt per delay, logs each failure, and gives up', async () => {
		await configureHook()
		await storeSecret()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const received: Received[] = []
		replyWith(received, 500, 500, 500)

		await fireQueueHook(workerEnv, EVENT, [0, 0])

		expect(received).toHaveLength(2)
		const outcomes = warn.mock.calls.map((call) => (call[1] as { outcome: string }).outcome)
		expect(outcomes).toEqual(['retryable_status', 'retryable_status', 'gave_up'])
		// Drain the unused reply so it can't leak into the next test.
		await fireQueueHook(workerEnv, EVENT, [0])
	})

	it('waits the given delay before each attempt', async () => {
		await configureHook()
		await storeSecret()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const received: Received[] = []
		replyWith(received, 503, 200)

		const startedAt = Date.now()
		await fireQueueHook(workerEnv, EVENT, [0, 30])

		expect(received).toHaveLength(2)
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25)
	})

	it('does not retry other statuses', async () => {
		await configureHook()
		await storeSecret()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const received: Received[] = []
		replyWith(received, 404)

		await fireQueueHook(workerEnv, EVENT, FAST)

		expect(received).toHaveLength(1)
		expect(warn.mock.calls[0][1]).toMatchObject({ outcome: 'rejected', status: 404 })
	})

	it('retries network errors and timeouts with a per-attempt abort signal', async () => {
		await configureHook()
		await storeSecret()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockRejectedValueOnce(new TypeError('connection reset'))
			.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
			.mockResolvedValueOnce(new Response(null, { status: 202 }))

		await fireQueueHook(workerEnv, EVENT, FAST)

		expect(fetchSpy).toHaveBeenCalledTimes(3)
		expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
	})

	it('does not follow redirects, which would carry the secret off the approved host', async () => {
		await configureHook()
		await storeSecret()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(null, { status: 302 }))

		await fireQueueHook(workerEnv, EVENT, FAST)

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(fetchSpy.mock.calls[0][1]?.redirect).toBe('manual')
	})

	it('never writes the secret value to logs or the task payload', async () => {
		await configureHook()
		await storeSecret()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const received: Received[] = []
		replyWith(received, 500, 404)

		await enqueueTask(
			env.FERMI_DB,
			{ channel: 'cloud', sender: 's', chatId: 'cloud', payload: '{}', queue: 'grok-bot' },
			{ env: workerEnv },
		)

		expect(received).toHaveLength(2)
		expect(warn).toHaveBeenCalled()
		expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET_VALUE)
		expect(JSON.stringify(received.map((r) => r.body))).not.toContain(SECRET_VALUE)
		expect(JSON.stringify(await listTasks(env.FERMI_DB, {}))).not.toContain(SECRET_VALUE)
	})
})

describe('enqueueTask wake', () => {
	const input = { channel: 'cloud', sender: 's', chatId: 'cloud', payload: '{}', queue: 'grok-bot' }

	it('hands the wake to waitUntil after the row exists', async () => {
		await configureHook()
		await storeSecret()
		const received: Received[] = []
		replyWith(received, 200)
		const waits: Promise<unknown>[] = []

		const task = await enqueueTask(env.FERMI_DB, input, {
			env: workerEnv,
			ctx: { waitUntil: (promise) => waits.push(promise) },
		})

		expect(waits).toHaveLength(1)
		await Promise.all(waits)
		expect(received).toEqual([
			{ body: { task_id: task.id, queue: 'grok-bot' }, auth: SECRET_VALUE },
		])
	})

	it('keeps the task when the hook fails', async () => {
		await configureHook()
		await storeSecret()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('down'))

		const task = await enqueueTask(env.FERMI_DB, input, { env: workerEnv })

		const tasks = await listTasks(env.FERMI_DB, { queue: 'grok-bot' })
		expect(tasks.map((t) => t.id)).toEqual([task.id])
		expect(fetchSpy).toHaveBeenCalledTimes(3)
	}, 15_000)

	it('fires on the channel webhook path', async () => {
		await configureHook('main')
		await storeSecret()
		await addToAllowlist(env.FERMI_DB, { channel: 'tg', senderId: '42' })
		const received: Received[] = []
		replyWith(received, 200)
		fetchMock
			.get('https://api.telegram.org')
			.intercept({ path: (p) => p.endsWith('/sendMessage'), method: 'POST' })
			.reply(200, { ok: true })
		const waits: Promise<unknown>[] = []

		const res = await handleTelegramWebhook(
			new Request('https://fermi.example.com/tg/webhook', {
				method: 'POST',
				headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
				body: JSON.stringify({
					update_id: 1,
					message: { message_id: 1, from: { id: 42 }, chat: { id: 42 }, text: 'hi' },
				}),
			}),
			workerEnv,
			{ waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as ExecutionContext,
		)

		expect(res.status).toBe(200)
		await Promise.all(waits)
		const [task] = await listTasks(env.FERMI_DB, { queue: 'main' })
		expect(received).toEqual([{ body: { task_id: task.id, queue: 'main' }, auth: SECRET_VALUE }])
	})
})
