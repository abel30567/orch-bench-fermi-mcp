import { env, fetchMock } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { describeTool } from './describe-tool.ts'
import { McpClient, resultJson } from './mcp-client.ts'

// team_spawn runs one inference turn against the Anthropic Messages API, which
// fetchMock answers below. ANTHROPIC_API_KEY is the fake from wrangler.test.jsonc.

const ALL_CURATED = ['memory_recall', 'memory_write', 'search', 'fs_read', 'fs_list']

let client: McpClient

beforeEach(async () => {
	await env.FERMI_DB.prepare('DELETE FROM team_spawns').run()
	client = new McpClient()
	await client.initialize()
})

/** Answer one Messages API call with end_turn and record the request body. */
function captureMessages(): Array<{ tools?: Array<{ name: string }> }> {
	const seen: Array<{ tools?: Array<{ name: string }> }> = []
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

const toolNames = (body: { tools?: Array<{ name: string }> }) =>
	(body.tools ?? []).map((t) => t.name)

describeTool('team_spawn', () => {
	it('offers the full curated tool set when allowed_tools is omitted', async () => {
		const seen = captureMessages()
		const result = resultJson<{ role: string; report: string }>(
			await client.callTool('team_spawn', { role: 'researcher', instructions: 'look around' }),
		)
		expect(result).toMatchObject({ role: 'researcher', report: 'subagent report' })
		expect(seen).toHaveLength(1)
		expect(toolNames(seen[0])).toEqual(ALL_CURATED)
	})

	it('offers exactly the allowed_tools subset', async () => {
		const seen = captureMessages()
		const result = resultJson<{ report: string }>(
			await client.callTool('team_spawn', {
				role: 'researcher',
				instructions: 'recall things',
				allowed_tools: ['memory_recall'],
			}),
		)
		expect(result.report).toBe('subagent report')
		expect(seen).toHaveLength(1)
		expect(toolNames(seen[0])).toEqual(['memory_recall'])
	})

	it('rejects an unknown tool name without spawning', async () => {
		const result = await client.callTool('team_spawn', {
			role: 'researcher',
			instructions: 'x',
			allowed_tools: ['memory_recall', 'shell_exec'],
		})
		expect(result.isError).toBe(true)
		expect(resultJson(result)).toMatchObject({
			error: 'Unknown allowed_tools: shell_exec',
			unknown: ['shell_exec'],
			available: ALL_CURATED,
		})
		expect(await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM team_spawns').first()).toEqual({
			n: 0,
		})
	})
})
