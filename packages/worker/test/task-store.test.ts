import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { countPendingTasks, enqueueTask } from '../src/lib/task-store.ts'
import { clearTasks, setupTasksSchema } from './setup-d1.ts'

const base = { channel: 'cloud', sender: 's', chatId: 'c', payload: '{}' }

describe('countPendingTasks', () => {
	beforeAll(setupTasksSchema)
	beforeEach(clearTasks)

	it('unscoped count excludes non-drain queues (fleet, broker, grok-bot)', async () => {
		await enqueueTask(env.FERMI_DB, base)
		await enqueueTask(env.FERMI_DB, { ...base, queue: 'agent:abc' })
		await enqueueTask(env.FERMI_DB, { ...base, queue: 'broker:ops' })
		await enqueueTask(env.FERMI_DB, { ...base, queue: 'grok-bot' })
		await enqueueTask(env.FERMI_DB, { ...base, queue: 'grok-bot' })
		expect(await countPendingTasks(env.FERMI_DB)).toBe(1)
	})

	it('scoped count returns only that queue', async () => {
		await enqueueTask(env.FERMI_DB, base)
		await enqueueTask(env.FERMI_DB, { ...base, queue: 'grok-bot' })
		await enqueueTask(env.FERMI_DB, { ...base, queue: 'grok-bot' })
		expect(await countPendingTasks(env.FERMI_DB, 'grok-bot')).toBe(2)
		expect(await countPendingTasks(env.FERMI_DB, 'main')).toBe(1)
	})
})
