import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleTasksPending } from '../src/channels/tasks-pending.ts'
import { putSecret } from '../src/lib/secrets-store.ts'
import { claimTasks, countPendingTasks, enqueueTask, isFleetQueue } from '../src/lib/task-store.ts'
import { setupSecretsSchema, setupTasksSchema } from './setup-d1.ts'

const testEnv = env as unknown as Env
const task = (queue?: string) => ({
	channel: 'cloud',
	sender: 'tester',
	chatId: 'cloud',
	payload: '{"v":1}',
	queue,
})

describe('pending counts', () => {
	beforeAll(setupTasksSchema)
	beforeEach(async () => {
		await env.FERMI_DB.prepare('DELETE FROM tasks').run()
		await enqueueTask(env.FERMI_DB, task())
		await enqueueTask(env.FERMI_DB, task('grok-bot'))
		await enqueueTask(env.FERMI_DB, task('grok-bot'))
		await enqueueTask(env.FERMI_DB, task('agent:ca_1'))
		await enqueueTask(env.FERMI_DB, task('broker:ops'))
	})

	it('hides non-drain queues from the unscoped count', async () => {
		expect(await countPendingTasks(env.FERMI_DB)).toBe(1)
	})

	it('still counts a non-drain queue when asked for it', async () => {
		expect(await countPendingTasks(env.FERMI_DB, 'grok-bot')).toBe(2)
	})

	it('keeps grok-bot claimable: it is not a fleet queue', async () => {
		expect(isFleetQueue('grok-bot')).toBe(false)
		expect(isFleetQueue('agent:ca_1')).toBe(true)
		expect(isFleetQueue('broker:ops')).toBe(true)
		const claimed = await claimTasks(env.FERMI_DB, { queue: 'grok-bot', claimedBy: 'grok-bot' })
		expect(claimed).toHaveLength(2)
	})

	function pending(query: string, authorization = 'Bearer test-admin-bearer') {
		return handleTasksPending(
			new Request(`https://fermi.test/admin/tasks/pending${query}`, {
				headers: { authorization },
			}),
			testEnv,
		)
	}

	it('GET /admin/tasks/pending scopes to ?queue=', async () => {
		expect(await (await pending('?queue=grok-bot')).json()).toEqual({ pending: 2 })
		expect(await (await pending('')).json()).toEqual({ pending: 1 })
	})

	it('GET /admin/tasks/pending still requires the bearer', async () => {
		expect((await pending('?queue=grok-bot', 'Bearer wrong')).status).toBe(401)
	})
})

describe('enqueue wake hook', () => {
	const fetchStub = vi.fn()

	beforeAll(async () => {
		await setupTasksSchema()
		await setupSecretsSchema()
	})
	beforeEach(async () => {
		fetchStub.mockReset()
		fetchStub.mockResolvedValue(new Response('ok'))
		vi.stubGlobal('fetch', fetchStub)
		await putSecret(
			{
				name: 'GROKBOT_WEBHOOK_KEY',
				value: 'value',
				scope: 'app',
				allowedHosts: ['grok.example.com'],
			},
			testEnv,
		)
		await env.FERMI_KV.put(
			'queue:hooks',
			JSON.stringify({
				'grok-bot': {
					url: 'https://grok.example.com/wake',
					auth_header: 'x-key',
					secret: 'GROKBOT_WEBHOOK_KEY',
				},
			}),
		)
	})
	afterEach(async () => {
		vi.unstubAllGlobals()
		await env.FERMI_KV.delete('queue:hooks')
	})

	it('fires once for a configured queue, kept alive by waitUntil', async () => {
		const ctx = createExecutionContext()
		const { id } = await enqueueTask(env.FERMI_DB, task('grok-bot'), { env: testEnv, ctx })
		await waitOnExecutionContext(ctx)
		expect(fetchStub).toHaveBeenCalledTimes(1)
		expect(JSON.parse(fetchStub.mock.calls[0][1].body)).toEqual({ task_id: id, queue: 'grok-bot' })
	})

	it('ignores queues without a hook', async () => {
		const ctx = createExecutionContext()
		await enqueueTask(env.FERMI_DB, task(), { env: testEnv, ctx })
		await waitOnExecutionContext(ctx)
		expect(fetchStub).not.toHaveBeenCalled()
	})
})
