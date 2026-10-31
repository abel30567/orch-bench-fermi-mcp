import { createExecutionContext, env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import worker from '../../src/index.ts'
import { getFleetConfig } from '../../src/lib/fleet-config.ts'
import { createCloudAgent, getBox, getCloudAgent, registerBox } from '../../src/lib/fleet-store.ts'
import { runnerPinFromConfig } from '../../src/lib/runner-pin.ts'
import { callApproved } from './approval.ts'
import { describeTool } from './describe-tool.ts'
import { type McpClient, resultJson } from './mcp-client.ts'
import { resetTables, session } from './tool-call.ts'

// The cloud fleet tools plus the bearer-gated runner pin route. Launches target
// a registered box, so nothing here reaches EC2.

const PROOF = JSON.stringify({ kind: 'artifact', name: 'out.diff', min_bytes: 1 })
const REF = 'a'.repeat(40)

let client: McpClient

beforeEach(async () => {
	await env.FERMI_KV.delete('fleet:config')
	client = await session()
})
afterEach(() => resetTables('cloud_agents', 'tasks'))

const agent = (id: string, boxId?: string) =>
	createCloudAgent(env.FERMI_DB, {
		id,
		queue: `agent:${id}`,
		prompt: 'p',
		proofContract: PROOF,
		boxId,
	})

async function controlPayloads(id: string) {
	const { results } = await env.FERMI_DB.prepare('SELECT payload FROM tasks WHERE queue = ?1')
		.bind(`agent:${id}:ctl`)
		.all<{ payload: string }>()
	return results.map((r) => JSON.parse(r.payload))
}

describeTool('cloud_agent_launch', () => {
	it('queues work for an agent on a registered box after approval', async () => {
		await registerBox(env.FERMI_DB, { boxId: 'box-private' })
		const launched = resultJson<{ ok: boolean; agent_id: string; queue: string }>(
			await callApproved(client, 'cloud_agent_launch', {
				prompt: 'Produce the diff for this task.',
				proof_contract: PROOF,
				box_id: 'box-private',
			}),
		)
		expect(launched.ok).toBe(true)
		expect(launched.queue).toBe(`agent:${launched.agent_id}`)
		expect(await getCloudAgent(env.FERMI_DB, launched.agent_id)).toMatchObject({
			box_id: 'box-private',
		})
	})

	it('refuses a free-text proof contract', async () => {
		const refused = resultJson<{ ok: boolean; error: string }>(
			await callApproved(client, 'cloud_agent_launch', {
				prompt: 'Produce the diff for this task.',
				proof_contract: 'it looks done to me',
				box_id: 'box-private',
			}),
		)
		expect(refused.ok).toBe(false)
		expect(refused.error).toMatch(/^invalid_proof_contract/)
	})
})

describeTool('cloud_agent_get', () => {
	it('returns the agent and answers not_found otherwise', async () => {
		await agent('ca_get')
		const found = resultJson<{ ok: boolean; agent: { id: string } }>(
			await client.callTool('cloud_agent_get', { id: 'ca_get' }),
		)
		expect(found).toMatchObject({ ok: true, agent: { id: 'ca_get' } })
		expect(resultJson(await client.callTool('cloud_agent_get', { id: 'ca_none' }))).toEqual({
			ok: false,
			error: 'not_found',
		})
	})
})

describeTool('cloud_agent_list', () => {
	it('filters by status', async () => {
		await agent('ca_listed')
		const all = resultJson<{ agents: Array<{ id: string }>; total: number }>(
			await client.callTool('cloud_agent_list', {}),
		)
		expect(all.agents.map((a) => a.id)).toEqual(['ca_listed'])
		const none = resultJson<{ total: number }>(
			await client.callTool('cloud_agent_list', { status: 'destroyed' }),
		)
		expect(none.total).toBe(0)
	})
})

describeTool('cloud_agent_followup', () => {
	it('queues the message on the control queue after approval', async () => {
		await agent('ca_follow')
		const queued = resultJson<{ ok: boolean }>(
			await callApproved(client, 'cloud_agent_followup', {
				id: 'ca_follow',
				message: 'also fix the docs',
				interrupt: true,
			}),
		)
		expect(queued.ok).toBe(true)
		expect(await controlPayloads('ca_follow')).toEqual([
			{ type: 'interrupt', message: 'also fix the docs' },
		])
	})
})

describeTool('cloud_agent_stop', () => {
	it('queues a stop and refuses a finished agent', async () => {
		await agent('ca_stop')
		expect(resultJson(await client.callTool('cloud_agent_stop', { id: 'ca_stop' }))).toMatchObject({
			ok: true,
		})
		expect(await controlPayloads('ca_stop')).toEqual([{ type: 'stop' }])
		expect(resultJson(await client.callTool('cloud_agent_stop', { id: 'ca_none' }))).toEqual({
			ok: false,
			error: 'not_found',
		})
	})
})

describeTool('cloud_agent_destroy', () => {
	it('marks the agent and its box destroyed after approval', async () => {
		await registerBox(env.FERMI_DB, { boxId: 'box-doomed' })
		await agent('ca_doomed', 'box-doomed')
		const destroyed = resultJson<{ ok: boolean }>(
			await callApproved(client, 'cloud_agent_destroy', {
				id: 'ca_doomed',
				reason: 'done with it',
			}),
		)
		expect(destroyed.ok).toBe(true)
		expect(await getCloudAgent(env.FERMI_DB, 'ca_doomed')).toMatchObject({
			status: 'destroyed',
			exit_reason: 'done with it',
		})
		expect(await getBox(env.FERMI_DB, 'box-doomed')).toMatchObject({ status: 'destroyed' })
	})
})

describeTool('box_heartbeat', () => {
	it('marks a registered box online and refuses an unknown one', async () => {
		await registerBox(env.FERMI_DB, { boxId: 'box-beat' })
		expect(
			resultJson(await client.callTool('box_heartbeat', { box_id: 'box-beat' })),
		).toMatchObject({ ok: true })
		expect(await getBox(env.FERMI_DB, 'box-beat')).toMatchObject({ status: 'online' })
		expect(resultJson(await client.callTool('box_heartbeat', { box_id: 'box-none' }))).toEqual({
			ok: false,
			error: 'box_not_found_or_destroyed',
		})
	})
})

describeTool('box_list', () => {
	it('lists registered boxes', async () => {
		await registerBox(env.FERMI_DB, { boxId: 'box-listed' })
		const listed = resultJson<{ boxes: Array<{ box_id: string }>; total: number }>(
			await client.callTool('box_list', {}),
		)
		expect(listed.boxes.map((b) => b.box_id)).toEqual(['box-listed'])
	})
})

describeTool('cloud_env_snapshot', () => {
	it('registers a snapshot after approval', async () => {
		const stored = resultJson<{ ok: boolean; env: { image_ref: string } }>(
			await callApproved(client, 'cloud_env_snapshot', { name: 'node', image_ref: 'ami-0' }),
		)
		expect(stored).toMatchObject({ ok: true, env: { image_ref: 'ami-0' } })
		await env.FERMI_KV.delete('cloudenv:node')
	})
})

describeTool('cloud_env_list', () => {
	it('lists registered snapshots', async () => {
		await env.FERMI_KV.put('cloudenv:listed', JSON.stringify({ name: 'listed' }))
		const listed = resultJson<{ envs: Array<{ name: string }>; total: number }>(
			await client.callTool('cloud_env_list', {}),
		)
		expect(listed).toEqual({ envs: [{ name: 'listed' }], total: 1 })
		await env.FERMI_KV.delete('cloudenv:listed')
	})
})

describe('POST /admin/fleet/pin-runner', () => {
	const bearerEnv = { ...env, FERMI_BEARER_TOKEN: 'test-bearer' } as unknown as Env

	const post = (body: string, token = 'test-bearer') =>
		worker.fetch(
			new Request('https://fermi.test/admin/fleet/pin-runner', {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` },
				body,
			}),
			bearerEnv,
			createExecutionContext(),
		)

	const serve = (path: string, body: string) =>
		fetchMock
			.get('https://raw.githubusercontent.com')
			.intercept({ path: `/abel30567/fermi-daemon/${REF}/${path}` })
			.reply(200, body)

	it('refuses a bad bearer, and a bad body with 400', async () => {
		expect((await post(JSON.stringify({ ref: REF }), 'wrong')).status).toBe(401)
		expect((await post('not json')).status).toBe(400)
		expect((await post(JSON.stringify({ ref: REF, files: {} }))).status).toBe(400)
	})

	it('pins a legacy ref', async () => {
		serve('box-runner.mjs', 'runner')
		const res = await post(JSON.stringify({ ref: REF }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ ok: true, ref: REF, bytes: 6 })
		expect(runnerPinFromConfig(await getFleetConfig(env))?.ref).toBe(REF)
	})

	it('pins a manifest', async () => {
		serve('box-runner.mjs', 'runner')
		serve('lib/util.mjs', 'util')
		const hash = async (text: string) =>
			Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(text))).toString('hex')
		const files = {
			'box-runner.mjs': await hash('runner'),
			'lib/util.mjs': await hash('util'),
		}
		const res = await post(JSON.stringify({ ref: REF, files }))
		expect(res.status).toBe(200)
		expect(runnerPinFromConfig(await getFleetConfig(env))).toEqual({ ref: REF, files })
	})
})
