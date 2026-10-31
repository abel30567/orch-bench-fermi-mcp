import { env, fetchMock } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { describeTool } from './describe-tool.ts'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

// team_spawn runs a real inference turn; the Messages API is faked with fetchMock
// and every request body is captured to assert what the subagent was offered.

const CURATED = ['memory_recall', 'memory_write', 'search', 'fs_read', 'fs_list']

interface MessagesRequest {
	tools: Array<{ name: string }>
	messages: Array<{ role: string; content: unknown }>
}

function message(content: unknown[], stopReason: string) {
	return {
		id: 'msg_contract',
		type: 'message',
		role: 'assistant',
		model: 'claude-haiku-4-5-20251001',
		content,
		stop_reason: stopReason,
		stop_sequence: null,
		usage: { input_tokens: 1, output_tokens: 1 },
	}
}

const endTurn = () => message([{ type: 'text', text: 'done' }], 'end_turn')

function fakeAnthropic(...replies: object[]): MessagesRequest[] {
	const requests: MessagesRequest[] = []
	for (const reply of replies) {
		fetchMock
			.get('https://api.anthropic.com')
			.intercept({ path: '/v1/messages', method: 'POST' })
			.reply(
				200,
				(opts) => {
					requests.push(JSON.parse(String(opts.body)))
					return reply
				},
				{ headers: { 'content-type': 'application/json' } },
			)
	}
	return requests
}

const toolNames = (request: MessagesRequest | undefined) => request?.tools.map((t) => t.name)

async function spawn(extra: Record<string, unknown>) {
	const client = await session()
	return client.callTool('team_spawn', { role: 'researcher', instructions: 'look', ...extra })
}

beforeEach(() => resetTables('team_spawns', 'memory'))

describeTool('team_spawn', () => {
	it('offers exactly the allowed tool', async () => {
		const requests = fakeAnthropic(endTurn())
		const result = await spawn({ allowed_tools: ['memory_recall'] })
		expect(resultJson(result)).toMatchObject({ role: 'researcher', report: 'done' })
		expect(requests).toHaveLength(1)
		expect(toolNames(requests[0])).toEqual(['memory_recall'])
	})

	it('offers the full curated set without allowed_tools', async () => {
		const requests = fakeAnthropic(endTurn())
		await spawn({})
		expect(toolNames(requests[0])).toEqual(CURATED)
	})

	it('offers the intersection when a registered tool is outside the curated set', async () => {
		const requests = fakeAnthropic(endTurn())
		await spawn({ allowed_tools: ['execute', 'fs_read'] })
		expect(toolNames(requests[0])).toEqual(['fs_read'])
	})

	it('offers no tools for an empty allowed_tools', async () => {
		const requests = fakeAnthropic(endTurn())
		await spawn({ allowed_tools: [] })
		expect(toolNames(requests[0])).toEqual([])
	})

	it('does not run a curated tool the subagent was not offered', async () => {
		const requests = fakeAnthropic(
			message(
				[
					{
						type: 'tool_use',
						id: 'toolu_1',
						name: 'memory_write',
						input: { kind: 'fact', body: 'smuggled' },
					},
				],
				'tool_use',
			),
			endTurn(),
		)
		await spawn({ allowed_tools: ['memory_recall'] })
		expect(requests[1]?.messages.at(-1)?.content).toEqual([
			{
				type: 'tool_result',
				tool_use_id: 'toolu_1',
				content: JSON.stringify({ error: 'Unknown tool: memory_write' }),
			},
		])
		expect(await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM memory').first()).toEqual({ n: 0 })
	})

	it('rejects an unknown tool name before spawning', async () => {
		const result = await spawn({ allowed_tools: ['memory_recall', 'no_such_tool'] })
		expect(resultJson(result)).toEqual({
			error: 'Unknown tools in allowed_tools: no_such_tool',
			unknown_tools: ['no_such_tool'],
		})
		expect(await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM team_spawns').first()).toEqual({
			n: 0,
		})
	})
})
