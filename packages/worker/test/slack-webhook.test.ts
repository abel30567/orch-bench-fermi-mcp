import { env, fetchMock } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleSlackBridgeWebhook } from '../src/channels/slack.ts'
import { addToAllowlist } from '../src/lib/allowlist-store.ts'
import { listTasks } from '../src/lib/task-store.ts'
import {
	clearAllowlist,
	clearSessions,
	clearTasks,
	setupAllowlistSchema,
	setupSessionsSchema,
	setupTasksSchema,
} from './setup-d1.ts'

const workerEnv = env as unknown as Env

const slackSent: { channel: string; text: string }[] = []

function interceptSlack() {
	fetchMock
		.get('https://slack.com')
		.intercept({
			path: '/api/chat.postMessage',
			method: 'POST',
			body: (b) => !b.includes('"channel":"DFAIL'),
		})
		.reply(200, (opts) => {
			slackSent.push(JSON.parse(String(opts.body)) as { channel: string; text: string })
			return { ok: true }
		})
		.persist()
	fetchMock
		.get('https://slack.com')
		.intercept({
			path: '/api/chat.postMessage',
			method: 'POST',
			body: (b) => b.includes('"channel":"DFAIL'),
		})
		.reply(200, { ok: false, error: 'channel_not_found' })
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
	await setupSessionsSchema()
	await setupAllowlistSchema()
	fetchMock.activate()
	fetchMock.disableNetConnect()
	interceptSlack()
})

describe('handleSlackBridgeWebhook', () => {
	beforeEach(async () => {
		slackSent.length = 0
		await clearTasks()
		await clearSessions()
		await clearAllowlist()
	})

	it('enqueues and acks an allowlisted DM sender', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
		const res = await handleSlackBridgeWebhook(
			webhookRequest({ author_id: 'U1', channel_id: 'D1', is_im: true, text: 'hi' }),
			workerEnv,
		)
		expect(res.status).toBe(200)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(1)
		expect(slackSent).toHaveLength(1)
		expect(slackSent[0].text).toContain('Got it')
	})

	it('returns 200 with exactly one task when the ack send fails', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
		const msg = { author_id: 'U1', channel_id: 'DFAIL', is_im: true, text: 'hi' }
		const res = await handleSlackBridgeWebhook(webhookRequest(msg), workerEnv)
		expect(res.status).toBe(200)
		const tasks = await listTasks(env.FERMI_DB)
		expect(tasks).toHaveLength(1)
		expect(tasks[0]).toMatchObject({ channel: 'sl', chat_id: 'DFAIL', payload: 'hi' })
	})

	it('returns 200 when the pairing code send fails', async () => {
		const res = await handleSlackBridgeWebhook(
			webhookRequest({ author_id: 'U2', channel_id: 'DFAIL', is_im: true, text: 'hi' }),
			workerEnv,
		)
		expect(res.status).toBe(200)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(0)
	})

	it('returns 200 when an approval reply send fails', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
		const res = await handleSlackBridgeWebhook(
			webhookRequest({
				author_id: 'U1',
				channel_id: 'DFAIL',
				is_im: true,
				text: '/approve NOPE1234',
			}),
			workerEnv,
		)
		expect(res.status).toBe(200)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(0)
	})
})
