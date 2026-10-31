import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleTasksPending } from '../src/channels/admin-tasks.ts'
import { claimTasks, countPendingTasks, enqueueTask, isFleetQueue } from '../src/lib/task-store.ts'
import { clearTasks, setupTasksSchema } from './setup-d1.ts'

const db = env.FERMI_DB

function enqueue(queue?: string) {
	return enqueueTask(db, { channel: 'cloud', sender: 's', chatId: 'cloud', payload: '{}', queue })
}

function pendingRequest(search = '', token = 'test-admin-bearer') {
	return new Request(`https://fermi.example.com/admin/tasks/pending${search}`, {
		headers: { authorization: `Bearer ${token}` },
	})
}

async function fetchPending(search = '') {
	const res = await handleTasksPending(pendingRequest(search), env as unknown as Env)
	return (await res.json()) as { pending: number }
}

beforeAll(async () => {
	await setupTasksSchema()
})

beforeEach(async () => {
	await clearTasks()
})

describe('countPendingTasks', () => {
	it('excludes fleet and non-drain queues from the unscoped count', async () => {
		await enqueue()
		await enqueue('agent:ca_1')
		await enqueue('agent:ca_1:ctl')
		await enqueue('broker:ops')
		await enqueue('grok-bot')

		expect(await countPendingTasks(db)).toBe(1)
	})

	it('reports zero to the drain while only grok-bot tasks wait', async () => {
		await enqueue('grok-bot')

		expect(await countPendingTasks(db)).toBe(0)
	})

	it('still counts unrelated queues in the unscoped count', async () => {
		await enqueue('grok-bot-staging')

		expect(await countPendingTasks(db)).toBe(1)
	})

	it('counts one queue when scoped', async () => {
		await enqueue('grok-bot')
		await enqueue('grok-bot')
		await enqueue()

		expect(await countPendingTasks(db, 'grok-bot')).toBe(2)
	})
})

describe('grok-bot queue', () => {
	it('stays claimable: it is not a fleet queue', async () => {
		const { id } = await enqueue('grok-bot')

		expect(isFleetQueue('grok-bot')).toBe(false)
		const claimed = await claimTasks(db, { queue: 'grok-bot', claimedBy: 'grok-bot' })
		expect(claimed.map((t) => t.id)).toEqual([id])
	})

	it('still treats fleet prefixes as fleet queues', () => {
		expect(isFleetQueue('agent:ca_1')).toBe(true)
		expect(isFleetQueue('broker:ops')).toBe(true)
		expect(isFleetQueue('main')).toBe(false)
		expect(isFleetQueue()).toBe(false)
	})
})

describe('GET /admin/tasks/pending', () => {
	it('scopes to ?queue= and keeps the drain signal without it', async () => {
		await enqueue('grok-bot')
		await enqueue('grok-bot')
		await enqueue()

		expect(await fetchPending('?queue=grok-bot')).toEqual({ pending: 2 })
		expect(await fetchPending()).toEqual({ pending: 1 })
	})

	it('rejects a bad bearer token', async () => {
		const res = await handleTasksPending(
			pendingRequest('?queue=grok-bot', 'wrong'),
			env as unknown as Env,
		)

		expect(res.status).toBe(401)
	})
})
