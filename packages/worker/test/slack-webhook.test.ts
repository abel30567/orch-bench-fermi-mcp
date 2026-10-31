import { env, fetchMock } from 'cloudflare:test'
import {
	type MockInstance,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { handleNarrate } from '../src/channels/narrate.ts'
import { handleSlackBridgeWebhook } from '../src/channels/slack.ts'
import { addToAllowlist, isAllowed } from '../src/lib/allowlist-store.ts'
import { listTasks } from '../src/lib/task-store.ts'
import type { FermiMCP } from '../src/mcp/index.ts'
import { registerChannelTools } from '../src/mcp/tools/channels.ts'
import {
	clearAllowlist,
	clearSessions,
	clearTasks,
	setupAllowlistSchema,
	setupSessionsSchema,
	setupTasksSchema,
} from './setup-d1.ts'

const workerEnv = { ...env, FERMI_BEARER_TOKEN: 'test-bearer' } as unknown as Env

const slackAttempts: { channel: string; text: string }[] = []

// Every Slack call is recorded; channels starting with CFAIL answer ok:false.
function interceptSlack() {
	fetchMock
		.get('https://slack.com')
		.intercept({ path: '/api/chat.postMessage', method: 'POST' })
		.reply(200, (opts) => {
			const body = JSON.parse(String(opts.body)) as { channel: string; text: string }
			slackAttempts.push(body)
			return body.channel.startsWith('CFAIL')
				? { ok: false, error: 'channel_not_found' }
				: { ok: true }
		})
		.persist()
}

function dm(chatId: string, text: string, authorId = 'U1'): Request {
	return new Request('https://fermi.example.com/sl/webhook', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-sl-bridge-secret': 'test-sl-secret' },
		body: JSON.stringify({ author_id: authorId, channel_id: chatId, is_im: true, text }),
	})
}

async function pairingKeys() {
	return (await env.FERMI_KV.list({ prefix: 'pairing:' })).keys.map((k) => k.name)
}

async function putPairing(code: string, chatId: string) {
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

describe('handleSlackBridgeWebhook reply failures', () => {
	let warn: MockInstance<typeof console.warn>

	beforeEach(async () => {
		slackAttempts.length = 0
		await clearTasks()
		await clearSessions()
		await clearAllowlist()
		await Promise.all((await pairingKeys()).map((k) => env.FERMI_KV.delete(k)))
		await addToAllowlist(env.FERMI_DB, { channel: 'sl', senderId: 'U1', addedBy: 'test' })
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('acks an enqueued message when the send works', async () => {
		const res = await handleSlackBridgeWebhook(dm('D1', 'hello'), workerEnv)
		expect(res.status).toBe(200)
		expect(await listTasks(env.FERMI_DB, { status: 'pending' })).toHaveLength(1)
		expect(slackAttempts).toEqual([{ channel: 'D1', text: 'Got it — working on it.' }])
		expect(warn).not.toHaveBeenCalled()
	})

	it('returns 200 and logs when the ack fails, so one message stays one task', async () => {
		const res = await handleSlackBridgeWebhook(dm('CFAIL1', 'hello'), workerEnv)
		expect(res.status).toBe(200)
		const tasks = await listTasks(env.FERMI_DB, { status: 'pending' })
		expect(tasks).toHaveLength(1)
		expect(tasks[0].payload).toBe('hello')
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('channel_not_found'))
	})

	it('returns 200 when the ack cannot be attempted at all', async () => {
		const noToken = { ...workerEnv, SLACK_BOT_TOKEN: '' } as Env
		const res = await handleSlackBridgeWebhook(dm('D1', 'hello'), noToken)
		expect(res.status).toBe(200)
		expect(await listTasks(env.FERMI_DB, { status: 'pending' })).toHaveLength(1)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('not configured'))
	})

	it('returns 200 when the pairing code send fails', async () => {
		const res = await handleSlackBridgeWebhook(dm('CFAIL1', 'hello', 'U9'), workerEnv)
		expect(res.status).toBe(200)
		expect(await pairingKeys()).toHaveLength(1)
		expect(await listTasks(env.FERMI_DB, { status: 'pending' })).toHaveLength(0)
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it('returns 200 and still tells the paired sender when the approver reply fails', async () => {
		await putPairing('ABC123', 'D2')
		const res = await handleSlackBridgeWebhook(dm('CFAIL1', '/approve ABC123'), workerEnv)
		expect(res.status).toBe(200)
		expect(await isAllowed(env.FERMI_DB, 'sl', 'U2')).toBe(true)
		expect(slackAttempts.map((a) => a.channel)).toEqual(['CFAIL1', 'D2'])
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it('returns 200 when the paired sender notice fails', async () => {
		await putPairing('ABC123', 'CFAIL2')
		const res = await handleSlackBridgeWebhook(dm('D1', '/approve ABC123'), workerEnv)
		expect(res.status).toBe(200)
		expect(await isAllowed(env.FERMI_DB, 'sl', 'U2')).toBe(true)
		expect(slackAttempts.map((a) => a.channel)).toEqual(['D1', 'CFAIL2'])
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it('returns 200 when the approval failure reply fails', async () => {
		const res = await handleSlackBridgeWebhook(dm('CFAIL1', '/approve NOPE'), workerEnv)
		expect(res.status).toBe(200)
		expect(warn).toHaveBeenCalledTimes(1)
	})
})

describe('other Slack send paths keep surfacing errors', () => {
	type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>

	function channelSendHandler(): ToolHandler {
		const handlers = new Map<string, ToolHandler>()
		const agent = {
			principal: 'owner',
			bindings: workerEnv,
			state: {},
			server: {
				tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => {
					handlers.set(name, handler)
				},
			},
		} as unknown as FermiMCP
		registerChannelTools(agent)
		return handlers.get('channel_send') as ToolHandler
	}

	it('channel_send fails when the Slack send fails', async () => {
		const send = channelSendHandler()
		await expect(send({ channel: 'sl', chat_id: 'CFAIL1', text: 'x' })).rejects.toThrow(
			/channel_not_found/,
		)
	})

	it('narrate fails when the Slack send fails', async () => {
		const req = new Request('https://fermi.example.com/admin/narrate', {
			method: 'POST',
			headers: { authorization: 'Bearer test-bearer' },
			body: JSON.stringify({ channel: 'sl', chat_id: 'CFAIL1', text: 'x' }),
		})
		await expect(handleNarrate(req, workerEnv)).rejects.toThrow(/channel_not_found/)
	})
})
