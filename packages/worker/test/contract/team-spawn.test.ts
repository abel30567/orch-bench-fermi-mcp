import { env, fetchMock } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { describeTool } from './describe-tool.ts'
import { McpClient, resultJson } from './mcp-client.ts'

// team_spawn runs one subagent turn against the Anthropic Messages API, which
// is answered here by fetchMock. The request body shows which tools the
// subagent was given.

const FULL_TOOL_SET = ['memory_recall', 'memory_write', 'search', 'fs_read', 'fs_list']

let client: McpClient

beforeEach(async () => {
	await env.FERMI_DB.prepare('DELETE FROM team_spawns').run()
	client = new McpClient()
	await client.initialize()
})

/** Answer one Anthropic messages call with end_turn and record the request body. */
function captureAnthropic(): Array<{ tools: Array<{ name: string }> }> {
	const seen: Array<{ tools: Array<{ name: string }> }> = []
	fetchMock
		.get('https://api.anthropic.com')
		.intercept({ path: '/v1/messages', method: 'POST' })
		.reply((opts) => {
			seen.push(JSON.parse(String(opts.body)))
			return {
				statusCode: 200,
				data: JSON.stringify({
					id: 'msg_contract',
					type: 'message',
					role: 'assistant',
					model: 'claude-haiku-4-5-20251001',
					content: [{ type: 'text', text: 'subagent report' }],
					stop_reason: 'end_turn',
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
				responseOptions: { headers: { 'content-type': 'application/json' } },
			}
		})
	return seen
}

describeTool('team_spawn', () => {
	it('without allowed_tools, the subagent gets the full curated tool set', async () => {
		const seen = captureAnthropic()
		const result = resultJson<{ role: string; report: string }>(
			await client.callTool('team_spawn', { role: 'researcher', instructions: 'look around' }),
		)
		expect(result).toMatchObject({ role: 'researcher', report: 'subagent report' })
		expect(seen).toHaveLength(1)
		expect(seen[0].tools.map((t) => t.name)).toEqual(FULL_TOOL_SET)
	})

	it('with allowed_tools, the subagent gets only those tools', async () => {
		const seen = captureAnthropic()
		const result = resultJson<{ report: string }>(
			await client.callTool('team_spawn', {
				role: 'researcher',
				instructions: 'recall only',
				allowed_tools: ['memory_recall'],
			}),
		)
		expect(result.report).toBe('subagent report')
		expect(seen).toHaveLength(1)
		expect(seen[0].tools.map((t) => t.name)).toEqual(['memory_recall'])
	})

	it('rejects an unknown tool name without calling the model or recording a spawn', async () => {
		const result = await client.callTool('team_spawn', {
			role: 'researcher',
			instructions: 'x',
			allowed_tools: ['memory_recall', 'no_such_tool'],
		})
		expect(result.isError).toBe(true)
		expect(resultJson(result)).toEqual({
			error: 'Unknown tool(s) in allowed_tools: no_such_tool',
			unknown: ['no_such_tool'],
			available: FULL_TOOL_SET,
		})
		expect(await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM team_spawns').first()).toEqual({
			n: 0,
		})
	})
})
