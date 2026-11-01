import { env, fetchMock } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleSlackBridgeWebhook } from '../src/channels/slack.ts'
import { addToAllowlist } from '../src/lib/allowlist-store.ts'
import { listTasks } from '../src/lib/task-store.ts'
import { clearAllowlist, clearTasks, setupAllowlistSchema, setupTasksSchema } from './setup-d1.ts'

const workerEnv = env as unknown as Env

// Every chat.postMessage to a channel starting with CFAIL fails like a missing channel.
function interceptSlack() {
	fetchMock
		.get('https://slack.com')
		.intercept({
			path: '/api/chat.postMessage',
			method: 'POST',
			body: (b) => !b.includes('"channel":"CFAIL'),
		})
		.reply(200, { ok: true })
		.persist()
	fetchMock
		.get('https://slack.com')
		.intercept({
			path: '/api/chat.postMessage',
			method: 'POST',
			body: (b) => b.includes('"channel":"CFAIL'),
		})
		.reply(200, { ok: false, error: 'channel_not_found' })
		.persist()
}

function bridgeRequest(body: unknown): Request {
	return new Request('https://fermi.example.com/sl/webhook', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-sl-bridge-secret': 'test-sl-secret' },
		body: JSON.stringify(body),
	})
}

beforeAll(async () => {
	await setupTasksSchema()
	await setupAllowlistSchema()
	fetchMock.activate()
	fetchMock.disableNetConnect()
	interceptSlack()
})

describe('handleSlackBridgeWebhook send failures', () => {
	beforeEach(async () => {
		await clearTasks()
		await clearAllowlist()
	})

	it('returns 200 and enqueues exactly once when the ack send fails', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
		const msg = { author_id: 'U1', channel_id: 'CFAIL_DM', is_im: true, text: 'do the thing' }

		const res = await handleSlackBridgeWebhook(bridgeRequest(msg), workerEnv)
		expect(res.status).toBe(200)

		const tasks = await listTasks(env.FERMI_DB)
		expect(tasks).toHaveLength(1)
		expect(tasks[0]).toMatchObject({ channel: 'sl', payload: 'do the thing' })
	})

	it('returns 200 when the pairing code send fails', async () => {
		const msg = { author_id: 'U2', channel_id: 'CFAIL_DM', is_im: true, text: 'hello' }
		const res = await handleSlackBridgeWebhook(bridgeRequest(msg), workerEnv)
		expect(res.status).toBe(200)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(0)
	})

	it('returns 200 when the approval reply send fails', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
		const msg = { author_id: 'U1', channel_id: 'CFAIL_DM', is_im: true, text: '/approve NOPE1234' }
		const res = await handleSlackBridgeWebhook(bridgeRequest(msg), workerEnv)
		expect(res.status).toBe(200)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(0)
	})
})
