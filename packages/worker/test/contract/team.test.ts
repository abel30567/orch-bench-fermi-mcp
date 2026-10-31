import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { curatedToolNames } from '../../src/channels/inference.ts'
import { describeTool } from './describe-tool.ts'
import { McpClient, resultJson } from './mcp-client.ts'

// team_spawn runs one subagent turn against the Anthropic Messages API, which
// fetchMock answers with a final text reply. The captured request body shows
// which tools the subagent was offered.

let client: McpClient

beforeEach(async () => {
	await env.FERMI_DB.prepare('DELETE FROM team_spawns').run()
	client = new McpClient()
	await client.initialize()
})

afterEach(() => env.FERMI_DB.prepare('DELETE FROM team_spawns').run())

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
	it('offers the subagent only the tools named in allowed_tools', async () => {
		const seen = captureAnthropic()
		const result = resultJson<{ role: string; report: string }>(
			await client.callTool('team_spawn', {
				role: 'researcher',
				instructions: 'look things up',
				allowed_tools: ['memory_recall'],
			}),
		)
		expect(result).toMatchObject({ role: 'researcher', report: 'subagent report' })
		expect(seen).toHaveLength(1)
		expect(seen[0].tools?.map((t) => t.name)).toEqual(['memory_recall'])
	})

	it('offers the full curated tool set when allowed_tools is omitted', async () => {
		const seen = captureAnthropic()
		await client.callTool('team_spawn', { role: 'writer', instructions: 'draft' })
		expect(seen).toHaveLength(1)
		expect(seen[0].tools?.map((t) => t.name)).toEqual(curatedToolNames())
		expect(curatedToolNames().length).toBeGreaterThan(1)
	})

	it('rejects an unknown tool name without spawning', async () => {
		const result = await client.callTool('team_spawn', {
			role: 'researcher',
			instructions: 'x',
			allowed_tools: ['memory_recall', 'shell_exec'],
		})
		expect(result.isError).toBe(true)
		expect(resultJson<{ error: string; unknown: string[] }>(result)).toMatchObject({
			error: 'Unknown tool(s) in allowed_tools: shell_exec',
			unknown: ['shell_exec'],
		})
		expect(await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM team_spawns').first()).toEqual({
			n: 0,
		})
	})
})
