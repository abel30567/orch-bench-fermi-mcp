import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { countPendingTasks, enqueueTask } from '../src/lib/task-store.ts'
import { clearTasks, setupTasksSchema } from './setup-d1.ts'

const db = env.FERMI_DB

async function enqueueOn(queue?: string) {
	return enqueueTask(db, { channel: 'cloud', sender: 's', chatId: 'c', payload: 'p', queue })
}

beforeAll(async () => {
	await setupTasksSchema()
})

beforeEach(async () => {
	await clearTasks()
})

describe('countPendingTasks', () => {
	it('unscoped count excludes fleet and non-drain queues (grok-bot)', async () => {
		await enqueueOn()
		await enqueueOn('main')
		await enqueueOn('grok-bot')
		await enqueueOn('grok-bot')
		await enqueueOn('agent:abc')
		await enqueueOn('broker:ops')
		expect(await countPendingTasks(db)).toBe(2)
	})

	it('scoped count returns only that queue', async () => {
		await enqueueOn()
		await enqueueOn('grok-bot')
		await enqueueOn('grok-bot')
		expect(await countPendingTasks(db, 'grok-bot')).toBe(2)
		expect(await countPendingTasks(db, 'main')).toBe(1)
	})
})
