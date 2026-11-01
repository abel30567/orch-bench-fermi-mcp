import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUEUE_HOOKS_KV_KEY, fireQueueHook } from '../src/lib/queue-hooks.ts'
import { putSecret } from '../src/lib/secrets-store.ts'
import { enqueueTask, listTasks } from '../src/lib/task-store.ts'
import { clearSecrets, clearTasks, setupSecretsSchema, setupTasksSchema } from './setup-d1.ts'

const HOOK_ORIGIN = 'https://grokbot.example.com'
const HOOK_PATH = '/routines/wake'
const SECRET_VALUE = 'sk-grokbot-super-secret-value'
const E = env as unknown as Env

async function configureHook(cfg?: Record<string, unknown>) {
	await env.FERMI_KV.put(
		QUEUE_HOOKS_KV_KEY,
		JSON.stringify({
			'grok-bot': {
				url: `${HOOK_ORIGIN}${HOOK_PATH}`,
				auth_header: 'x-grokbot-key',
				secret: 'GROKBOT_WEBHOOK_KEY',
				...cfg,
			},
		}),
	)
}

async function storeSecret(allowedHosts = ['grokbot.example.com']) {
	await putSecret(
		{ name: 'GROKBOT_WEBHOOK_KEY', value: SECRET_VALUE, scope: 'app', allowedHosts },
		E,
	)
}

type Captured = { body: unknown; headers: Record<string, string> }

function intercept(statuses: number[], captured: Captured[]) {
	for (const status of statuses) {
		fetchMock
			.get(HOOK_ORIGIN)
			.intercept({ path: HOOK_PATH, method: 'POST' })
			.reply(status, (opts) => {
				captured.push({
					body: JSON.parse(String(opts.body)),
					headers: Object.fromEntries(
						Object.entries(opts.headers as Record<string, string>).map(([k, v]) => [
							k.toLowerCase(),
							v,
						]),
					),
				})
				return { ok: status < 400 }
			})
	}
}

describe('queue hooks (outbound wake on enqueue)', () => {
	let logSpy: ReturnType<typeof vi.spyOn>

	beforeAll(async () => {
		await setupTasksSchema()
		await setupSecretsSchema()
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})

	beforeEach(async () => {
		await clearTasks()
		await clearSecrets()
		await env.FERMI_KV.delete(QUEUE_HOOKS_KV_KEY)
		logSpy = vi.spyOn(console, 'log')
	})

	afterEach(() => {
		const logged = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
		expect(logged).not.toContain(SECRET_VALUE)
		logSpy.mockRestore()
		fetchMock.assertNoPendingInterceptors()
	})

	it('no config → no-op (no fetch attempted)', async () => {
		const res = await fireQueueHook(E, { task_id: 't1', queue: 'grok-bot' }, [0])
		expect(res).toMatchObject({ fired: false, skipped: 'not_configured' })
	})

	it('config for another queue only → no-op', async () => {
		await configureHook()
		await storeSecret()
		const res = await fireQueueHook(E, { task_id: 't1', queue: 'main' }, [0])
		expect(res).toMatchObject({ fired: false, skipped: 'not_configured' })
	})

	it('configured URL but missing secret → no-op', async () => {
		await configureHook()
		const res = await fireQueueHook(E, { task_id: 't1', queue: 'grok-bot' }, [0])
		expect(res).toMatchObject({ fired: false, skipped: 'secret_not_found' })
	})

	it('host not in the secret allowed_hosts → skipped', async () => {
		await configureHook()
		await storeSecret(['other.example.com'])
		const res = await fireQueueHook(E, { task_id: 't1', queue: 'grok-bot' }, [0])
		expect(res).toMatchObject({ fired: false, skipped: 'host_not_approved' })
	})

	it('enqueue on a configured queue POSTs {task_id, queue} once with the secret auth header', async () => {
		await configureHook()
		await storeSecret()
		const captured: Captured[] = []
		intercept([200], captured)

		const pending: Promise<unknown>[] = []
		const payload = JSON.stringify({ v: 1, ask: 'triage inbox', deadline_min: 30 })
		const { id } = await enqueueTask(
			E.FERMI_DB,
			{ channel: 'cloud', sender: 'claude-code', chatId: 'cloud', payload, queue: 'grok-bot' },
			{ env: E, waitUntil: (p) => pending.push(p) },
		)
		expect(pending).toHaveLength(1)
		await Promise.all(pending)

		expect(captured).toHaveLength(1)
		expect(captured[0].body).toEqual({ task_id: id, queue: 'grok-bot' })
		expect(captured[0].headers['x-grokbot-key']).toBe(SECRET_VALUE)
		// Secret never lands in the task row
		const [row] = await listTasks(E.FERMI_DB, { queue: 'grok-bot' })
		expect(row.payload).toBe(payload)
		expect(JSON.stringify(row)).not.toContain(SECRET_VALUE)
	})

	it('enqueue on an unconfigured queue does not fire', async () => {
		await configureHook()
		await storeSecret()
		const pending: Promise<unknown>[] = []
		await enqueueTask(
			E.FERMI_DB,
			{ channel: 'tg', sender: 'u', chatId: 'c', payload: 'hi' },
			{ env: E, waitUntil: (p) => pending.push(p) },
		)
		await Promise.all(pending)
		// disableNetConnect + no interceptor: any fetch would have been logged as a failed attempt
		expect(logSpy.mock.calls.map(String).join('\n')).not.toContain('attempt_failed')
	})

	it('retries on 5xx and 429, then succeeds', async () => {
		await configureHook()
		await storeSecret()
		const captured: Captured[] = []
		intercept([503, 429, 200], captured)
		const res = await fireQueueHook(E, { task_id: 't2', queue: 'grok-bot' }, [0, 1, 1])
		expect(res).toMatchObject({ fired: true, ok: true, attempts: 3, status: 200 })
		expect(captured).toHaveLength(3)
	})

	it('retries are bounded by delaysMs and logged', async () => {
		await configureHook()
		await storeSecret()
		const captured: Captured[] = []
		intercept([500, 502], captured)
		const res = await fireQueueHook(E, { task_id: 't3', queue: 'grok-bot' }, [0, 1])
		expect(res).toMatchObject({ fired: true, ok: false, attempts: 2, status: 502 })
		const logged = logSpy.mock.calls.map(String).join('\n')
		expect(logged).toContain('gave_up')
		expect(logged.match(/attempt_failed/g)).toHaveLength(2)
	})

	it('does not retry on a non-retryable 4xx', async () => {
		await configureHook()
		await storeSecret()
		const captured: Captured[] = []
		intercept([401], captured)
		const res = await fireQueueHook(E, { task_id: 't4', queue: 'grok-bot' }, [0, 1, 1])
		expect(res).toMatchObject({ fired: true, ok: false, attempts: 1, status: 401 })
	})

	it('retries network errors', async () => {
		await configureHook()
		await storeSecret()
		fetchMock
			.get(HOOK_ORIGIN)
			.intercept({ path: HOOK_PATH, method: 'POST' })
			.replyWithError(new Error('connection reset'))
		const captured: Captured[] = []
		intercept([200], captured)
		const res = await fireQueueHook(E, { task_id: 't5', queue: 'grok-bot' }, [0, 1])
		expect(res).toMatchObject({ ok: true, attempts: 2 })
	})

	it('a hung endpoint times out per attempt and is retried', async () => {
		await configureHook({ timeout_ms: 50 })
		await storeSecret()
		fetchMock
			.get(HOOK_ORIGIN)
			.intercept({ path: HOOK_PATH, method: 'POST' })
			.reply(200, {})
			.delay(1_000)
		const captured: Captured[] = []
		intercept([200], captured)
		const res = await fireQueueHook(E, { task_id: 't7', queue: 'grok-bot' }, [0, 1])
		expect(res).toMatchObject({ ok: true, attempts: 2 })
		expect(logSpy.mock.calls.map(String).join('\n')).toMatch(
			/"attempt":1,"error":"(TimeoutError|AbortError)"/,
		)
	})

	it('hook failure never fails the enqueue', async () => {
		await configureHook()
		await storeSecret()
		const captured: Captured[] = []
		intercept([500, 500], captured)
		const pending: Promise<unknown>[] = []
		const created = await enqueueTask(
			E.FERMI_DB,
			{ channel: 'cloud', sender: 's', chatId: 'cloud', payload: '{}', queue: 'grok-bot' },
			{ env: E, waitUntil: (p) => pending.push(p), delaysMs: [0, 1] },
		)
		expect(created.id).toBeTruthy()
		// the scheduled promise resolves (never rejects) even when every attempt fails
		await expect(Promise.all(pending)).resolves.toBeDefined()
		expect(await listTasks(E.FERMI_DB, { queue: 'grok-bot' })).toHaveLength(1)
	})

	it('malformed config is a logged no-op', async () => {
		await env.FERMI_KV.put(QUEUE_HOOKS_KV_KEY, '{not json')
		const res = await fireQueueHook(E, { task_id: 't6', queue: 'grok-bot' }, [0])
		expect(res).toMatchObject({ fired: false, skipped: 'not_configured' })
	})
})
