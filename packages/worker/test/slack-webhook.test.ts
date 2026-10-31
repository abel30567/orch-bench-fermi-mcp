import { env, fetchMock } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sendChannelMessage } from '../src/channels/dispatch.ts'
import { handleSlackBridgeWebhook } from '../src/channels/slack.ts'
import { addToAllowlist, isAllowed } from '../src/lib/allowlist-store.ts'
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

// Persistent interceptors for the whole file; `slackSent` is reset per test.
// Channels starting with CFAIL get `channel_not_found`.
const slackSent: { channel: string; text: string }[] = []

function interceptSlack() {
	fetchMock
		.get('https://slack.com')
		.intercept({
			path: '/api/chat.postMessage',
			method: 'POST',
			body: (b) => !b.includes('"channel":"CFAIL'),
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
			body: (b) => b.includes('"channel":"CFAIL'),
		})
		.reply(200, { ok: false, error: 'channel_not_found' })
		.persist()
}

function bridgeRequest(body: Record<string, unknown>): Request {
	return new Request('https://fermi.example.com/sl/webhook', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-sl-bridge-secret': 'test-sl-secret' },
		body: JSON.stringify(body),
	})
}

function dm(authorId: string, channelId: string, text: string) {
	return bridgeRequest({ author_id: authorId, channel_id: channelId, is_im: true, text })
}

beforeAll(async () => {
	await setupTasksSchema()
	await setupSessionsSchema()
	await setupAllowlistSchema()
	fetchMock.activate()
	fetchMock.disableNetConnect()
	interceptSlack()
})

describe('handleSlackBridgeWebhook with failing replies', () => {
	beforeEach(async () => {
		slackSent.length = 0
		await clearTasks()
		await clearSessions()
		await clearAllowlist()
		const { keys } = await env.FERMI_KV.list({ prefix: 'pairing:' })
		await Promise.all(keys.map((k) => env.FERMI_KV.delete(k.name)))
	})

	it('returns 200 and enqueues once when the ack send fails', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U42' })
		const res = await handleSlackBridgeWebhook(dm('U42', 'CFAIL1', 'hello'), workerEnv)
		expect(res.status).toBe(200)
		const tasks = await listTasks(env.FERMI_DB, { status: 'pending' })
		expect(tasks).toHaveLength(1)
		expect(tasks[0]).toMatchObject({ channel: 'sl', sender: 'U42', chat_id: 'CFAIL1' })
		expect(slackSent).toHaveLength(0)
	})

	it('acks on success', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U42' })
		const res = await handleSlackBridgeWebhook(dm('U42', 'D1', 'hello'), workerEnv)
		expect(res.status).toBe(200)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(1)
		expect(slackSent).toHaveLength(1)
		expect(slackSent[0].text).toContain('Got it')
	})

	it('returns 200 and keeps the pairing code when the pairing send fails', async () => {
		const res = await handleSlackBridgeWebhook(dm('U77', 'CFAIL2', 'hi'), workerEnv)
		expect(res.status).toBe(200)
		const { keys } = await env.FERMI_KV.list({ prefix: 'pairing:' })
		expect(keys).toHaveLength(1)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(0)
	})

	it('returns 200 and still approves when the approval replies fail', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U42' })
		await env.FERMI_KV.put(
			'pairing:CODE1234',
			JSON.stringify({ channel: 'sl', senderId: 'U77', chatId: 'CFAIL3' }),
		)
		const res = await handleSlackBridgeWebhook(dm('U42', 'CFAIL4', '/approve CODE1234'), workerEnv)
		expect(res.status).toBe(200)
		expect(await isAllowed(env.FERMI_DB, 'sl', 'U77')).toBe(true)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(0)
	})

	it('returns 200 when the approval-failed reply fails', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U42' })
		const res = await handleSlackBridgeWebhook(dm('U42', 'CFAIL5', '/approve NOPE0000'), workerEnv)
		expect(res.status).toBe(200)
	})
})

describe('channel_send path to Slack', () => {
	it('still surfaces a failing send as an error', async () => {
		await expect(sendChannelMessage(workerEnv, 'sl', 'CFAIL6', 'lost')).rejects.toThrow(
			/channel_not_found/,
		)
	})
})
