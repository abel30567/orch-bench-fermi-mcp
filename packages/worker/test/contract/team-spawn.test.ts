import { env, fetchMock } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { describeTool } from './describe-tool.ts'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

// team_spawn runs the real inference loop against a fetchMock-ed Messages API;
// each reply is captured so the tests can assert on the outgoing request.

const CURATED = ['memory_recall', 'memory_write', 'search', 'fs_read', 'fs_list']

type AnthropicRequest = {
	tools: Array<{ name: string }>
	messages: Array<{ role: string; content: unknown }>
}

function anthropicReplies(...replies: Array<Record<string, unknown>>): AnthropicRequest[] {
	const requests: AnthropicRequest[] = []
	for (const reply of replies) {
		fetchMock
			.get('https://api.anthropic.com')
			.intercept({ path: '/v1/messages', method: 'POST' })
			.reply(
				200,
				(opts) => {
					requests.push(JSON.parse(String(opts.body)))
					return {
						id: 'msg_contract',
						type: 'message',
						role: 'assistant',
						model: 'claude-haiku-4-5-20251001',
						stop_sequence: null,
						usage: { input_tokens: 1, output_tokens: 1 },
						...reply,
					}
				},
				{ headers: { 'content-type': 'application/json' } },
			)
	}
	return requests
}

const endTurn = { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }

async function spawn(args: Record<string, unknown> = {}) {
	const client = await session()
	return client.callTool('team_spawn', { role: 'researcher', instructions: 'look', ...args })
}

const toolNames = (request: AnthropicRequest | undefined) => request?.tools.map((t) => t.name)

beforeEach(() => resetTables('team_spawns', 'memory'))

describeTool('team_spawn', () => {
	it('offers exactly the allowed tool to the subagent', async () => {
		const requests = anthropicReplies(endTurn)
		const result = await spawn({ allowed_tools: ['memory_recall'] })
		expect(resultJson(result)).toMatchObject({ role: 'researcher', report: 'done' })
		expect(requests).toHaveLength(1)
		expect(toolNames(requests[0])).toEqual(['memory_recall'])
	})

	it('offers the full curated set without allowed_tools', async () => {
		const requests = anthropicReplies(endTurn)
		await spawn()
		expect(toolNames(requests[0])).toEqual(CURATED)
	})

	it('offers no tools for an empty allowed_tools', async () => {
		const requests = anthropicReplies(endTurn)
		await spawn({ allowed_tools: [] })
		expect(toolNames(requests[0])).toEqual([])
	})

	it('does not run a tool the model calls outside allowed_tools', async () => {
		const requests = anthropicReplies(
			{
				content: [
					{
						type: 'tool_use',
						id: 'toolu_1',
						name: 'memory_write',
						input: { kind: 'fact', body: 'smuggled' },
					},
				],
				stop_reason: 'tool_use',
			},
			endTurn,
		)
		await spawn({ allowed_tools: ['memory_recall'] })
		expect(requests).toHaveLength(2)
		expect(requests[1]?.messages.at(-1)?.content).toEqual([
			{
				type: 'tool_result',
				tool_use_id: 'toolu_1',
				content: JSON.stringify({ error: 'Unknown tool: memory_write' }),
			},
		])
		expect(await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM memory').first()).toEqual({ n: 0 })
	})

	it('rejects a name outside the curated set before spawning', async () => {
		// fs_write is a real MCP tool, but not one the subagent can be given.
		const result = await spawn({ allowed_tools: ['memory_recall', 'fs_write', 'nope'] })
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('Unknown allowed_tools: fs_write, nope.')
		expect(await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM team_spawns').first()).toEqual({
			n: 0,
		})
	})
})
