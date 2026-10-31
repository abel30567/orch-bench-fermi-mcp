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
			body: (b) => b.includes('"channel":"CFAIL_OKFALSE"'),
		})
		.reply(200, { ok: false, error: 'channel_not_found' })
		.persist()
	fetchMock
		.get('https://slack.com')
		.intercept({
			path: '/api/chat.postMessage',
			method: 'POST',
			body: (b) => b.includes('"channel":"CFAIL_HTTP"'),
		})
		.reply(500, 'upstream error')
		.persist()
}

function webhookRequest(body: unknown): Request {
	return new Request('https://fermi.example.com/sl/webhook', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-sl-bridge-secret': 'test-sl-secret' },
		body: JSON.stringify(body),
	})
}

function dm(channelId: string, text: string) {
	return webhookRequest({ author_id: 'U1', channel_id: channelId, is_im: true, text })
}

async function seedPairing(code: string, chatId: string) {
	await env.FERMI_KV.put(
		`pairing:${code}`,
		JSON.stringify({ channel: 'sl', senderId: 'U2', chatId }),
	)
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
		const { keys } = await env.FERMI_KV.list({ prefix: 'pairing:' })
		await Promise.all(keys.map((k) => env.FERMI_KV.delete(k.name)))
	})

	it('enqueues and acks an allowlisted DM sender', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
		const res = await handleSlackBridgeWebhook(dm('D1', 'hello'), workerEnv)
		expect(res.status).toBe(200)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(1)
		expect(slackSent).toEqual([{ channel: 'D1', text: 'Got it — working on it.' }])
	})

	it.each(['CFAIL_OKFALSE', 'CFAIL_HTTP'])(
		'returns 200 with one task when the ack fails (%s)',
		async (channel) => {
			await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
			const res = await handleSlackBridgeWebhook(dm(channel, 'hello'), workerEnv)
			expect(res.status).toBe(200)
			const tasks = await listTasks(env.FERMI_DB)
			expect(tasks).toHaveLength(1)
			expect(tasks[0]).toMatchObject({ channel: 'sl', chat_id: channel, payload: 'hello' })
		},
	)

	it('returns 200 with one task when no bot token is configured', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
		const noToken = { ...workerEnv, SLACK_BOT_TOKEN: undefined } as Env
		const res = await handleSlackBridgeWebhook(dm('D1', 'hello'), noToken)
		expect(res.status).toBe(200)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(1)
	})

	it('returns 200 and keeps the pairing code when its send fails', async () => {
		const res = await handleSlackBridgeWebhook(dm('CFAIL_OKFALSE', 'hi'), workerEnv)
		expect(res.status).toBe(200)
		expect(await listTasks(env.FERMI_DB)).toHaveLength(0)
		const { keys } = await env.FERMI_KV.list({ prefix: 'pairing:' })
		expect(keys).toHaveLength(1)
	})

	it('still notifies the approved sender when the approver reply fails', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
		await seedPairing('ABC123', 'D2')
		const res = await handleSlackBridgeWebhook(dm('CFAIL_OKFALSE', '/approve abc123'), workerEnv)
		expect(res.status).toBe(200)
		expect(await isAllowed(env.FERMI_DB, 'sl', 'U2')).toBe(true)
		expect(slackSent).toEqual([
			{ channel: 'D2', text: "You're approved. Send me a message anytime." },
		])
		expect(await listTasks(env.FERMI_DB)).toHaveLength(0)
	})

	it('returns 200 when the approved sender cannot be notified', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
		await seedPairing('ABC123', 'CFAIL_HTTP')
		const res = await handleSlackBridgeWebhook(dm('D1', '/approve ABC123'), workerEnv)
		expect(res.status).toBe(200)
		expect(await isAllowed(env.FERMI_DB, 'sl', 'U2')).toBe(true)
		expect(slackSent).toEqual([{ channel: 'D1', text: 'Approved sender U2.' }])
	})

	it('returns 200 when an approval failure reply fails', async () => {
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1' })
		const res = await handleSlackBridgeWebhook(dm('CFAIL_OKFALSE', '/approve NOPE'), workerEnv)
		expect(res.status).toBe(200)
	})

	it('rejects a wrong bridge secret', async () => {
		const res = await handleSlackBridgeWebhook(
			new Request('https://fermi.example.com/sl/webhook', { method: 'POST', body: '{}' }),
			workerEnv,
		)
		expect(res.status).toBe(401)
	})
})
