import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { QUEUE_HOOKS_KEY } from '../src/lib/queue-hooks.ts'
import {
	countPendingTasks,
	enqueueTask,
	isFleetQueue,
	pendingTaskSummary,
} from '../src/lib/task-store.ts'
import { clearTasks, setupTasksSchema } from './setup-d1.ts'

const workerEnv = env as unknown as Env

async function enqueue(queue?: string) {
	return enqueueTask(env.FERMI_DB, {
		channel: 'cloud',
		sender: 's',
		chatId: 'c',
		payload: 'p',
		queue,
	})
}

describe('countPendingTasks', () => {
	beforeAll(async () => {
		await setupTasksSchema()
	})
	beforeEach(async () => {
		await clearTasks()
		await env.FERMI_KV.delete(QUEUE_HOOKS_KEY)
	})

	it('unscoped count excludes fleet queues and grok-bot', async () => {
		await enqueue()
		await enqueue('main')
		await enqueue('agent:a1')
		await enqueue('broker:ops')
		await enqueue('grok-bot')
		await enqueue('grok-bot')
		expect(await countPendingTasks(env.FERMI_DB)).toBe(2)
	})

	it('unscoped count excludes extra configured non-drain queues', async () => {
		await enqueue('main')
		await enqueue('ops-bot')
		expect(await countPendingTasks(env.FERMI_DB)).toBe(2)
		expect(await countPendingTasks(env.FERMI_DB, undefined, { excludeQueues: ['ops-bot'] })).toBe(1)
	})

	it('scoped count returns only that queue', async () => {
		await enqueue('main')
		await enqueue('grok-bot')
		await enqueue('grok-bot')
		expect(await countPendingTasks(env.FERMI_DB, 'grok-bot')).toBe(2)
		expect(await countPendingTasks(env.FERMI_DB, 'main')).toBe(1)
	})

	it('grok-bot stays claimable by task_claim (not a fleet queue)', () => {
		expect(isFleetQueue('grok-bot')).toBe(false)
		expect(isFleetQueue('agent:x')).toBe(true)
	})
})

describe('GET /admin/tasks/pending body', () => {
	beforeAll(async () => {
		await setupTasksSchema()
	})
	beforeEach(async () => {
		await clearTasks()
		await env.FERMI_KV.delete(QUEUE_HOOKS_KEY)
	})

	it('?queue= returns that queue count; no param keeps the drain count', async () => {
		await enqueue('main')
		await enqueue('grok-bot')
		await enqueue('grok-bot')
		await enqueue('hooked')
		expect(await pendingTaskSummary(workerEnv, 'grok-bot')).toEqual({
			queue: 'grok-bot',
			pending: 2,
		})
		expect(await pendingTaskSummary(workerEnv, null)).toEqual({ pending: 2 })
		await env.FERMI_KV.put(
			QUEUE_HOOKS_KEY,
			JSON.stringify({ hooked: { url: 'https://x.test/h', auth_header: 'x-key', secret: 'K' } }),
		)
		expect(await pendingTaskSummary(workerEnv, null)).toEqual({ pending: 1 })
	})
})
