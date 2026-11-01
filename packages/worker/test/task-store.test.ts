import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
	NON_DRAIN_QUEUES,
	countPendingTasks,
	enqueueTask,
	isNonDrainQueue,
	pendingCountForUrl,
} from '../src/lib/task-store.ts'
import { clearTasks, setupTasksSchema } from './setup-d1.ts'

const db = env.FERMI_DB

function add(queue?: string) {
	return enqueueTask(db, { channel: 'cloud', sender: 's', chatId: 'c', payload: 'p', queue })
}

beforeAll(async () => {
	await setupTasksSchema()
})

beforeEach(async () => {
	await clearTasks()
})

describe('countPendingTasks', () => {
	it('unscoped count excludes fleet and grok-bot (non-drain) queues', async () => {
		await add()
		await add('main')
		await add('grok-bot')
		await add('grok-bot')
		await add('agent:a1')
		await add('agent:a1:ctl')
		await add('broker:ops')
		expect(await countPendingTasks(db)).toBe(2)
	})

	it('scoped count returns only that queue', async () => {
		await add()
		await add('grok-bot')
		await add('grok-bot')
		expect(await countPendingTasks(db, 'grok-bot')).toBe(2)
		expect(await countPendingTasks(db, 'main')).toBe(1)
	})

	it('grok-bot only: drain wake signal stays at zero', async () => {
		await add('grok-bot')
		expect(await countPendingTasks(db)).toBe(0)
	})

	it('isNonDrainQueue covers prefixes and exact names', () => {
		expect(NON_DRAIN_QUEUES).toContain('grok-bot')
		expect(isNonDrainQueue('grok-bot')).toBe(true)
		expect(isNonDrainQueue('agent:x')).toBe(true)
		expect(isNonDrainQueue('broker:ops')).toBe(true)
		expect(isNonDrainQueue('grok-bot-2')).toBe(false)
		expect(isNonDrainQueue('main')).toBe(false)
		expect(isNonDrainQueue(undefined)).toBe(false)
	})
})

describe('GET /admin/tasks/pending', () => {
	it('honors ?queue= and keeps unscoped behavior without it', async () => {
		await add()
		await add('grok-bot')
		await add('grok-bot')
		const u = (q: string) => new URL(`https://fermi.test/admin/tasks/pending${q}`)
		expect(await pendingCountForUrl(db, u('?queue=grok-bot'))).toBe(2)
		expect(await pendingCountForUrl(db, u(''))).toBe(1)
		expect(await pendingCountForUrl(db, u('?queue='))).toBe(1)
	})
})
