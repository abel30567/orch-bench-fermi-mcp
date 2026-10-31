import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleAdminTasksPending } from '../src/lib/admin-tasks.ts'
import { countPendingTasks, enqueueTask, isNonDrainQueue } from '../src/lib/task-store.ts'
import { clearTasks, setupTasksSchema } from './setup-d1.ts'

const workerEnv = env as unknown as Env

async function seed(queue?: string) {
	await enqueueTask(env.FERMI_DB, {
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
		await seed() // main
		await seed('main')
		await seed('grok-bot')
		await seed('grok-bot')
		await seed('grok-bot')
		await seed('agent:abc')
		await seed('broker:ops')
	})

	it('unscoped count excludes non-drain queues (fleet, broker, grok-bot)', async () => {
		expect(await countPendingTasks(env.FERMI_DB)).toBe(2)
	})

	it('scoped count returns that queue only', async () => {
		expect(await countPendingTasks(env.FERMI_DB, 'grok-bot')).toBe(3)
		expect(await countPendingTasks(env.FERMI_DB, 'agent:abc')).toBe(1)
		expect(await countPendingTasks(env.FERMI_DB, 'empty')).toBe(0)
	})

	it('isNonDrainQueue classifies queues', () => {
		expect(isNonDrainQueue('grok-bot')).toBe(true)
		expect(isNonDrainQueue('agent:x')).toBe(true)
		expect(isNonDrainQueue('broker:ops')).toBe(true)
		expect(isNonDrainQueue('main')).toBe(false)
		expect(isNonDrainQueue('grok-bot-2')).toBe(false)
		expect(isNonDrainQueue(undefined)).toBe(false)
	})

	describe('GET /admin/tasks/pending', () => {
		function get(path: string, token = workerEnv.FERMI_BEARER_TOKEN) {
			return handleAdminTasksPending(
				new Request(`https://fermi.test${path}`, { headers: { authorization: `Bearer ${token}` } }),
				workerEnv,
			)
		}

		it('rejects a bad bearer token', async () => {
			const res = await get('/admin/tasks/pending?queue=grok-bot', 'wrong')
			expect(res.status).toBe(401)
		})

		it('?queue=grok-bot returns that queue’s pending count', async () => {
			const res = await get('/admin/tasks/pending?queue=grok-bot')
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ pending: 3 })
		})

		it('no param keeps the drain-scoped count', async () => {
			const res = await get('/admin/tasks/pending')
			expect(await res.json()).toEqual({ pending: 2 })
		})
	})
})
