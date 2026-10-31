import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { describeTool } from './describe-tool.ts'
import { McpClient, resultJson } from './mcp-client.ts'

// team_spawn runs the subagent through the Anthropic Messages API; fetchMock
// answers it and records each request so the offered tool list can be asserted.

interface MessagesRequest {
	tools: Array<{ name: string }>
	messages: Array<{ role: string; content: unknown }>
}

const CURATED = ['memory_recall', 'memory_write', 'search', 'fs_read', 'fs_list']

let client: McpClient

beforeEach(async () => {
	client = new McpClient()
	await client.initialize()
})

// team_spawns rows reference sessions; drop them so other files can reset sessions.
afterEach(() => env.FERMI_DB.prepare('DELETE FROM team_spawns').run())

function message(content: unknown[], stop_reason: string) {
	return {
		id: 'msg_contract',
		type: 'message',
		role: 'assistant',
		model: 'claude-haiku-4-5-20251001',
		content,
		stop_reason,
		stop_sequence: null,
		usage: { input_tokens: 1, output_tokens: 1 },
	}
}

/** Answer successive /v1/messages calls with `replies`, recording each request body. */
function fakeAnthropic(...replies: unknown[]): MessagesRequest[] {
	const seen: MessagesRequest[] = []
	for (const reply of replies) {
		fetchMock
			.get('https://api.anthropic.com')
			.intercept({ path: '/v1/messages', method: 'POST' })
			.reply((opts) => {
				seen.push(JSON.parse(String(opts.body)))
				return {
					statusCode: 200,
					data: JSON.stringify(reply),
					responseOptions: { headers: { 'content-type': 'application/json' } },
				}
			})
	}
	return seen
}

const endTurn = message([{ type: 'text', text: 'subagent report' }], 'end_turn')

describeTool('team_spawn', () => {
	it('offers only the allowed_tools to the subagent', async () => {
		const seen = fakeAnthropic(endTurn)
		const result = resultJson<{ role: string; report: string }>(
			await client.callTool('team_spawn', {
				role: 'researcher',
				instructions: 'look it up',
				allowed_tools: ['memory_recall'],
			}),
		)
		expect(result).toMatchObject({ role: 'researcher', report: 'subagent report' })
		expect(seen).toHaveLength(1)
		expect(seen[0].tools.map((t) => t.name)).toEqual(['memory_recall'])
	})

	it('offers the full curated set without allowed_tools', async () => {
		const seen = fakeAnthropic(endTurn)
		await client.callTool('team_spawn', { role: 'writer', instructions: 'draft it' })
		expect(seen).toHaveLength(1)
		expect(seen[0].tools.map((t) => t.name)).toEqual(CURATED)
	})

	it('refuses a tool call outside allowed_tools', async () => {
		const seen = fakeAnthropic(
			message([{ type: 'tool_use', id: 'tu_1', name: 'fs_list', input: {} }], 'tool_use'),
			endTurn,
		)
		await client.callTool('team_spawn', {
			role: 'researcher',
			instructions: 'list files',
			allowed_tools: ['memory_recall'],
		})
		expect(seen).toHaveLength(2)
		expect(seen[1].messages.at(-1)?.content).toEqual([
			{
				type: 'tool_result',
				tool_use_id: 'tu_1',
				content: JSON.stringify({ error: 'Tool not allowed: fs_list' }),
			},
		])
	})

	it('rejects an unknown allowed_tools name without spawning', async () => {
		const result = await client.callTool('team_spawn', {
			role: 'researcher',
			instructions: 'look it up',
			allowed_tools: ['memory_recall', 'shell_exec'],
		})
		expect(result.isError).toBe(true)
		expect(resultJson<{ error: string }>(result).error).toBe(
			`Unknown allowed_tools: shell_exec. Known: ${CURATED.join(', ')}`,
		)
		expect(await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM team_spawns').first()).toEqual({
			n: 0,
		})
	})
})
