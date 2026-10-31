import { env, fetchMock } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleSlackBridgeWebhook } from '../src/channels/slack.ts'
import { addToAllowlist, isAllowed } from '../src/lib/allowlist-store.ts'
import { listTasks } from '../src/lib/task-store.ts'
import { clearAllowlist, clearTasks, setupAllowlistSchema, setupTasksSchema } from './setup-d1.ts'

const workerEnv = env as unknown as Env

let slackAttempts = 0

// Every chat.postMessage fails, as it does in production for a missing channel.
function interceptFailingSlack() {
	fetchMock
		.get('https://slack.com')
		.intercept({ path: '/api/chat.postMessage', method: 'POST' })
		.reply(200, () => {
			slackAttempts++
			return { ok: false, error: 'channel_not_found' }
		})
		.persist()
}

function webhookRequest(body: unknown): Request {
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
	interceptFailingSlack()
})

describe('handleSlackBridgeWebhook when the reply send fails', () => {
	beforeEach(async () => {
		slackAttempts = 0
		await clearTasks()
		await clearAllowlist()
		const { keys } = await env.FERMI_KV.list({ prefix: 'pairing:' })
		await Promise.all(keys.map((k) => env.FERMI_KV.delete(k.name)))
	})

	it('returns 200 after enqueueing so sl-bridge does not retry and double-enqueue', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
		const res = await handleSlackBridgeWebhook(
			webhookRequest({ author_id: 'U1', channel_id: 'D1', is_im: true, text: 'do the thing' }),
			workerEnv,
		)
		expect(res.status).toBe(200)
		expect(slackAttempts).toBe(1)
		const tasks = await listTasks(env.FERMI_DB)
		expect(tasks).toHaveLength(1)
		expect(tasks[0]).toMatchObject({ channel: 'sl', payload: 'do the thing' })
	})

	it('returns 200 when the pairing code reply fails', async () => {
		const res = await handleSlackBridgeWebhook(
			webhookRequest({ author_id: 'U2', channel_id: 'D2', is_im: true, text: 'hello' }),
			workerEnv,
		)
		expect(res.status).toBe(200)
		expect(slackAttempts).toBe(1)
		const { keys } = await env.FERMI_KV.list({ prefix: 'pairing:' })
		expect(keys).toHaveLength(1)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(0)
	})

	it('returns 200 and still approves when the approval replies fail', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'UOWNER' })
		await env.FERMI_KV.put(
			'pairing:ABCD1234',
			JSON.stringify({ channel: 'sl', senderId: 'U3', chatId: 'D3' }),
		)
		const res = await handleSlackBridgeWebhook(
			webhookRequest({
				author_id: 'UOWNER',
				channel_id: 'DOWNER',
				is_im: true,
				text: '/approve abcd1234',
			}),
			workerEnv,
		)
		expect(res.status).toBe(200)
		expect(slackAttempts).toBe(2)
		expect(await isAllowed(env.FERMI_DB, 'sl', 'U3')).toBe(true)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(0)
	})
})
