import { env, fetchMock } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

const slackSent: { channel: string; text: string }[] = []

// Channels starting with CFAIL answer ok:false, like a real `channel_not_found`.
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

function bridgeRequest(body: unknown): Request {
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

describe('handleSlackBridgeWebhook reply failures', () => {
	beforeEach(async () => {
		slackSent.length = 0
		await clearTasks()
		await clearSessions()
		await clearAllowlist()
		const { keys } = await env.FERMI_KV.list({ prefix: 'pairing:' })
		await Promise.all(keys.map((k) => env.FERMI_KV.delete(k.name)))
	})

	it('acks an allowed DM and enqueues it once', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
		const res = await handleSlackBridgeWebhook(
			bridgeRequest({ author_id: 'U1', channel_id: 'D1', is_im: true, text: 'do it' }),
			workerEnv,
		)
		expect(res.status).toBe(200)
		expect(slackSent).toEqual([{ channel: 'D1', text: 'Got it — working on it.' }])
		expect(await listTasks(env.FERMI_DB)).toHaveLength(1)
	})

	it('returns 200 and enqueues exactly once when the ack send fails', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
		const res = await handleSlackBridgeWebhook(
			bridgeRequest({ author_id: 'U1', channel_id: 'CFAIL_DM', is_im: true, text: 'do it' }),
			workerEnv,
		)
		expect(res.status).toBe(200)
		const tasks = await listTasks(env.FERMI_DB)
		expect(tasks).toHaveLength(1)
		expect(tasks[0]).toMatchObject({ channel: 'sl', chat_id: 'CFAIL_DM', payload: 'do it' })
	})

	it('returns 200 and keeps the pairing code when the pairing send fails', async () => {
		const res = await handleSlackBridgeWebhook(
			bridgeRequest({ author_id: 'U2', channel_id: 'CFAIL_DM', is_im: true, text: 'hi' }),
			workerEnv,
		)
		expect(res.status).toBe(200)
		const { keys } = await env.FERMI_KV.list({ prefix: 'pairing:' })
		expect(keys).toHaveLength(1)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(0)
	})

	it('returns 200 and still approves when the approval replies fail', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'OWNER' })
		await env.FERMI_KV.put(
			'pairing:ABCD1234',
			JSON.stringify({ channel: 'sl', senderId: 'U3', chatId: 'CFAIL_NEW' }),
		)
		const res = await handleSlackBridgeWebhook(
			bridgeRequest({
				author_id: 'OWNER',
				channel_id: 'CFAIL_OWNER',
				is_im: true,
				text: '/approve abcd1234',
			}),
			workerEnv,
		)
		expect(res.status).toBe(200)
		expect(await isAllowed(env.FERMI_DB, 'sl', 'U3')).toBe(true)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(0)
	})

	it('returns 200 when the approval-failed reply fails', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'OWNER' })
		const res = await handleSlackBridgeWebhook(
			bridgeRequest({
				author_id: 'OWNER',
				channel_id: 'CFAIL_OWNER',
				is_im: true,
				text: '/approve NOPE0000',
			}),
			workerEnv,
		)
		expect(res.status).toBe(200)
	})
})
