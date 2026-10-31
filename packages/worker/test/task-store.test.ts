import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleAdminTasksPending } from '../src/channels/tasks-admin.ts'
import {
	NON_DRAIN_QUEUES,
	countPendingTasks,
	enqueueTask,
	isFleetQueue,
} from '../src/lib/task-store.ts'
import { clearTasks, setupTasksSchema } from './setup-d1.ts'

const db = env.FERMI_DB

function enqueue(queue?: string) {
	return enqueueTask(db, { channel: 'cloud', sender: 's', chatId: 'c', payload: '{}', queue })
}

beforeAll(async () => {
	await setupTasksSchema()
})

beforeEach(async () => {
	await clearTasks()
})

describe('countPendingTasks', () => {
	it('unscoped count excludes fleet, broker and grok-bot queues', async () => {
		await enqueue()
		await enqueue('main')
		await enqueue('agent:a1')
		await enqueue('agent:a1:ctl')
		await enqueue('broker:ops')
		await enqueue('grok-bot')
		await enqueue('grok-bot')
		expect(await countPendingTasks(db)).toBe(2)
	})

	it('excludes every configured non-drain queue', async () => {
		for (const q of NON_DRAIN_QUEUES) await enqueue(q)
		expect(await countPendingTasks(db)).toBe(0)
	})

	it('still counts queues that merely start with a non-drain name', async () => {
		await enqueue('grok-bot-staging')
		expect(await countPendingTasks(db)).toBe(1)
	})

	it('scoped count returns only that queue', async () => {
		await enqueue('main')
		await enqueue('grok-bot')
		await enqueue('grok-bot')
		expect(await countPendingTasks(db, 'grok-bot')).toBe(2)
		expect(await countPendingTasks(db, 'main')).toBe(1)
	})

	it('grok-bot is not a fleet queue, so task_claim may claim it', () => {
		expect(isFleetQueue('grok-bot')).toBe(false)
		expect(isFleetQueue('agent:x')).toBe(true)
		expect(isFleetQueue('broker:ops')).toBe(true)
	})
})

describe('GET /admin/tasks/pending', () => {
	async function pending(query = '') {
		const res = await handleAdminTasksPending(
			new Request(`https://fermi.test/admin/tasks/pending${query}`, {
				headers: { authorization: `Bearer ${env.FERMI_BEARER_TOKEN}` },
			}),
			env as unknown as Env,
		)
		expect(res.status).toBe(200)
		return ((await res.json()) as { pending: number }).pending
	}

	it('scopes to ?queue= and keeps the unscoped drain signal otherwise', async () => {
		await enqueue('main')
		await enqueue('grok-bot')
		await enqueue('grok-bot')
		await enqueue('agent:a1')
		expect(await pending('?queue=grok-bot')).toBe(2)
		expect(await pending()).toBe(1)
	})

	it('requires the admin bearer', async () => {
		const res = await handleAdminTasksPending(
			new Request('https://fermi.test/admin/tasks/pending?queue=grok-bot'),
			env as unknown as Env,
		)
		expect(res.status).toBe(401)
	})
})
