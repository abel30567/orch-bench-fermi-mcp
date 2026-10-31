import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { describeTool } from './describe-tool.ts'
import { McpClient, resultJson } from './mcp-client.ts'

// team_spawn runs the inference loop against the Anthropic Messages API with
// the fake key from wrangler.test.jsonc; every request is answered by fetchMock.

interface MessagesRequest {
	tools?: Array<{ name: string }>
	messages: Array<{ role: string; content: unknown }>
}

const CURATED = ['memory_recall', 'memory_write', 'search', 'fs_read', 'fs_list']

let client: McpClient

beforeEach(async () => {
	client = new McpClient()
	await client.initialize()
})

afterEach(() => env.FERMI_DB.prepare('DELETE FROM team_spawns').run())

const message = (content: unknown[], stop_reason: string) => ({
	id: 'msg_contract',
	type: 'message',
	role: 'assistant',
	model: 'claude-haiku-4-5-20251001',
	content,
	stop_reason,
	stop_sequence: null,
	usage: { input_tokens: 1, output_tokens: 1 },
})

/** Answer successive Messages API calls with `replies`, recording each request body. */
function anthropic(...replies: unknown[]): MessagesRequest[] {
	const seen: MessagesRequest[] = []
	for (const reply of replies) {
		fetchMock
			.get('https://api.anthropic.com')
			.intercept({ path: '/v1/messages', method: 'POST' })
			.reply(
				200,
				(opts) => {
					seen.push(JSON.parse(String(opts.body)))
					return reply
				},
				{ headers: { 'content-type': 'application/json' } },
			)
	}
	return seen
}

const done = message([{ type: 'text', text: 'subagent report' }], 'end_turn')

describeTool('team_spawn', () => {
	it('offers only the allowed_tools to the subagent', async () => {
		const seen = anthropic(done)
		const result = resultJson<{ role: string; report: string }>(
			await client.callTool('team_spawn', {
				role: 'researcher',
				instructions: 'look it up',
				allowed_tools: ['memory_recall'],
			}),
		)
		expect(result).toMatchObject({ role: 'researcher', report: 'subagent report' })
		expect(seen).toHaveLength(1)
		expect(seen[0].tools?.map((t) => t.name)).toEqual(['memory_recall'])
	})

	it('offers the full curated set when allowed_tools is omitted', async () => {
		const seen = anthropic(done)
		await client.callTool('team_spawn', { role: 'writer', instructions: 'draft it' })
		expect(seen[0].tools?.map((t) => t.name)).toEqual(CURATED)
	})

	it('rejects an unknown tool name before spawning', async () => {
		const result = resultJson<{ error: string }>(
			await client.callTool('team_spawn', {
				role: 'researcher',
				instructions: 'x',
				allowed_tools: ['memory_recall', 'shell_exec'],
			}),
		)
		expect(result.error).toContain('Unknown allowed_tools: shell_exec')
		const spawns = await env.FERMI_DB.prepare('SELECT COUNT(*) AS n FROM team_spawns').first()
		expect(spawns).toEqual({ n: 0 })
	})

	it('refuses a tool call outside allowed_tools', async () => {
		const seen = anthropic(
			message(
				[{ type: 'tool_use', id: 'tu_1', name: 'fs_read', input: { path: 'secret.txt' } }],
				'tool_use',
			),
			done,
		)
		await client.callTool('team_spawn', {
			role: 'researcher',
			instructions: 'read it',
			allowed_tools: ['memory_recall'],
		})
		expect(seen).toHaveLength(2)
		expect(seen[1].messages.at(-1)?.content).toEqual([
			{
				type: 'tool_result',
				tool_use_id: 'tu_1',
				content: JSON.stringify({ error: 'Tool not allowed: fs_read' }),
			},
		])
	})
})
