import { env, fetchMock } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { describeTool } from './describe-tool.ts'
import { resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

// team_spawn runs a subagent turn against the Anthropic Messages API; the API is
// faked with fetchMock so the test can assert which tools the subagent is offered.

const ALL_CURATED = ['memory_recall', 'memory_write', 'search', 'fs_read', 'fs_list']

interface MessagesRequest {
	tools?: Array<{ name: string }>
	messages: unknown[]
}

beforeEach(() => resetTables('team_spawns'))

/** Answer one POST /v1/messages with an end_turn reply and record the request body. */
function captureAnthropic(): MessagesRequest[] {
	const seen: MessagesRequest[] = []
	fetchMock
		.get('https://api.anthropic.com')
		.intercept({ path: '/v1/messages', method: 'POST' })
		.reply((opts) => {
			seen.push(JSON.parse(String(opts.body)))
			return {
				statusCode: 200,
				data: JSON.stringify({
					id: 'msg_test',
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
	it('offers the subagent exactly the allowed_tools it was given', async () => {
		const seen = captureAnthropic()
		const client = await session()
		const out = resultJson<{ role: string; report: string }>(
			await client.callTool('team_spawn', {
				role: 'researcher',
				instructions: 'look things up',
				allowed_tools: ['memory_recall'],
			}),
		)
		expect(out).toMatchObject({ role: 'researcher', report: 'subagent report' })
		expect(seen).toHaveLength(1)
		expect(seen[0].tools?.map((t) => t.name)).toEqual(['memory_recall'])
	})

	it('offers the full curated tool set when allowed_tools is omitted', async () => {
		const seen = captureAnthropic()
		const client = await session()
		await client.callTool('team_spawn', { role: 'writer', instructions: 'draft' })
		expect(seen).toHaveLength(1)
		expect(seen[0].tools?.map((t) => t.name)).toEqual(ALL_CURATED)
	})

	it('rejects an unknown tool name without spawning or calling the model', async () => {
		const client = await session()
		const result = await client.callTool('team_spawn', {
			role: 'researcher',
			instructions: 'x',
			allowed_tools: ['memory_recall', 'mac_shell'],
		})
		expect(result.isError).toBe(true)
		expect(resultJson(result)).toMatchObject({
			error: 'Unknown allowed_tools: mac_shell',
			unknown: ['mac_shell'],
			available: ALL_CURATED,
		})
		const row = await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM team_spawns').first()
		expect(row).toEqual({ n: 0 })
	})
})
