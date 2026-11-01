import { env } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createCloudAgent, registerBox } from '../../src/lib/fleet-store.ts'
import { callApproved } from './approval.ts'
import { describeTool } from './describe-tool.ts'
import { McpClient, resultJson } from './mcp-client.ts'

// Fleet tools over MCP. No compute is provisioned: launches target a private
// worker box, so dispatch never reaches AWS.

const PROOF = JSON.stringify({ kind: 'artifact', name: 'report.md' })

let client: McpClient

beforeEach(async () => {
	await env.FERMI_DB.prepare('DELETE FROM cloud_agents').run()
	client = new McpClient()
	await client.initialize()
})

// setup.ts resets `boxes` before each test; agents reference boxes, so clear them first.
afterEach(async () => {
	await env.FERMI_DB.prepare('DELETE FROM cloud_agents').run()
	await env.FERMI_KV.delete('cloudenv:contract-env')
	await env.FERMI_KV.delete('cloudenv:listed-env')
})

async function privateBox(id = 'box-private'): Promise<string> {
	await registerBox(env.FERMI_DB, { boxId: id, provider: 'private' as never })
	return id
}

async function liveAgent(id: string): Promise<string> {
	await createCloudAgent(env.FERMI_DB, {
		id,
		queue: `agent:${id}`,
		prompt: 'do the thing',
		proofContract: PROOF,
	})
	return id
}

describeTool('cloud_agent_launch', () => {
	it('rejects a free-text proof contract', async () => {
		const out = resultJson(
			await callApproved(client, 'cloud_agent_launch', {
				prompt: 'write a report please',
				proof_contract: 'it should look good',
			}),
		)
		expect(out).toMatchObject({ ok: false })
		expect(String(out.error)).toMatch(/^invalid_proof_contract/)
	})

	it('launches onto an existing box without provisioning', async () => {
		const box = await privateBox()
		const out = resultJson<{ ok: boolean; agent_id: string; provision: { reason: string } }>(
			await callApproved(client, 'cloud_agent_launch', {
				prompt: 'write a report please',
				proof_contract: PROOF,
				box_id: box,
			}),
		)
		expect(out).toMatchObject({ ok: true, provision: { dispatched: false } })
		expect(out.agent_id).toMatch(/^ca_/)
	})
})

describeTool('cloud_agent_get', () => {
	it('returns not_found for an unknown id', async () => {
		expect(resultJson(await client.callTool('cloud_agent_get', { id: 'ca_nope' }))).toEqual({
			ok: false,
			error: 'not_found',
		})
	})

	it('returns the agent record', async () => {
		await liveAgent('ca_get')
		const out = resultJson<{ ok: boolean; agent: { id: string } }>(
			await client.callTool('cloud_agent_get', { id: 'ca_get' }),
		)
		expect(out.ok).toBe(true)
		expect(out.agent.id).toBe('ca_get')
	})
})

describeTool('cloud_agent_list', () => {
	it('lists agents', async () => {
		await liveAgent('ca_list')
		const out = resultJson<{ total: number }>(await client.callTool('cloud_agent_list', {}))
		expect(out.total).toBe(1)
	})
})

describeTool('cloud_agent_followup', () => {
	it('queues a follow-up for a live agent', async () => {
		await liveAgent('ca_fu')
		const out = resultJson(
			await callApproved(client, 'cloud_agent_followup', { id: 'ca_fu', message: 'also X' }),
		)
		expect(out).toMatchObject({ ok: true })
	})

	it('returns not_found for an unknown id', async () => {
		const out = resultJson(
			await callApproved(client, 'cloud_agent_followup', { id: 'ca_nope', message: 'hi' }),
		)
		expect(out).toEqual({ ok: false, error: 'not_found' })
	})
})

describeTool('cloud_agent_stop', () => {
	it('queues a stop for a live agent', async () => {
		await liveAgent('ca_stop')
		const out = resultJson(await client.callTool('cloud_agent_stop', { id: 'ca_stop' }))
		expect(out).toMatchObject({ ok: true })
	})
})

describeTool('cloud_agent_destroy', () => {
	it('destroys once, then refuses', async () => {
		await liveAgent('ca_destroy')
		const first = resultJson(
			await callApproved(client, 'cloud_agent_destroy', { id: 'ca_destroy' }),
		)
		expect(first).toMatchObject({ ok: true })
		const again = resultJson(
			await callApproved(client, 'cloud_agent_destroy', { id: 'ca_destroy' }),
		)
		expect(again).toEqual({ ok: false, error: 'already_destroyed' })
	})
})

describeTool('box_heartbeat', () => {
	it('marks a registered box online and refuses an unknown one', async () => {
		const box = await privateBox('box-hb')
		expect(resultJson(await client.callTool('box_heartbeat', { box_id: box }))).toMatchObject({
			ok: true,
		})
		expect(resultJson(await client.callTool('box_heartbeat', { box_id: 'box-none' }))).toEqual({
			ok: false,
			error: 'box_not_found_or_destroyed',
		})
	})
})

describeTool('box_list', () => {
	it('lists registered boxes', async () => {
		await privateBox('box-ls')
		const out = resultJson<{ boxes: Array<{ box_id: string }> }>(
			await client.callTool('box_list', {}),
		)
		expect(out.boxes.map((b) => b.box_id)).toContain('box-ls')
	})
})

describeTool('cloud_env_snapshot', () => {
	it('registers an environment snapshot', async () => {
		const out = resultJson(
			await callApproved(client, 'cloud_env_snapshot', {
				name: 'contract-env',
				image_ref: 'ami-00000000',
			}),
		)
		expect(out).toMatchObject({ ok: true, env: { name: 'contract-env' } })
	})
})

describeTool('cloud_env_list', () => {
	it('lists registered snapshots', async () => {
		await env.FERMI_KV.put(
			'cloudenv:listed-env',
			JSON.stringify({ name: 'listed-env', image_ref: 'ami-1' }),
		)
		const out = resultJson<{ envs: Array<{ name: string }> }>(
			await client.callTool('cloud_env_list', {}),
		)
		expect(out.envs.map((e) => e.name)).toContain('listed-env')
	})
})
