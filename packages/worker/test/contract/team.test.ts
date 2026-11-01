import { env, fetchMock } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { describeTool } from './describe-tool.ts'
import { McpClient, resultJson } from './mcp-client.ts'

// team_spawn runs one subagent turn against the Anthropic Messages API, which
// fetchMock answers (ANTHROPIC_API_KEY is a fake value in wrangler.test.jsonc).

const CURATED_TOOLS = ['memory_recall', 'memory_write', 'search', 'fs_read', 'fs_list']

let client: McpClient

beforeEach(async () => {
	await env.FERMI_DB.prepare('DELETE FROM team_spawns').run()
	client = new McpClient()
	await client.initialize()
})

/** Answer one Messages API call with an end_turn reply and record its body. */
function captureAnthropic(): Array<{ tools?: Array<{ name: string }> }> {
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

describeTool('team_spawn', () => {
	it('without allowed_tools, the subagent gets the full curated tool set', async () => {
		const seen = captureAnthropic()
		const result = resultJson<{ role: string; report: string }>(
			await client.callTool('team_spawn', { role: 'researcher', instructions: 'look around' }),
		)
		expect(result).toMatchObject({ role: 'researcher', report: 'subagent report' })
		expect(seen).toHaveLength(1)
		expect(seen[0].tools?.map((t) => t.name)).toEqual(CURATED_TOOLS)
	})

	it('with allowed_tools, the subagent gets exactly those tools', async () => {
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
		expect(seen[0].tools?.map((t) => t.name)).toEqual(['memory_recall'])
	})

	it('rejects an unknown tool name without spawning', async () => {
		const result = await client.callTool('team_spawn', {
			role: 'researcher',
			instructions: 'x',
			allowed_tools: ['memory_recall', 'shell_exec'],
		})
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('Unknown tool(s) in allowed_tools: shell_exec')
		expect(await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM team_spawns').first()).toEqual({
			n: 0,
		})
	})
})
