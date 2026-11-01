import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type LaunchInput, launchCloudAgent } from '../src/lib/fleet-launch.ts'
import { getCloudAgent, listCloudAgents, registerBox } from '../src/lib/fleet-store.ts'
import { putSecret } from '../src/lib/secrets-store.ts'
import { listTasks } from '../src/lib/task-store.ts'
import { cloudAgentLaunchSchema } from '../src/mcp/tools/cloud-agents.ts'
import {
	clearFleet,
	clearSecrets,
	clearTasks,
	setupFleetSchema,
	setupSecretsSchema,
	setupTasksSchema,
} from './setup-d1.ts'

const base: LaunchInput = {
	prompt: 'build feature X end to end',
	proof_contract: JSON.stringify({ kind: 'artifact', name: 'out.diff' }),
}

describe('launchCloudAgent account', () => {
	beforeAll(async () => {
		await setupFleetSchema()
		await setupTasksSchema()
		await setupSecretsSchema()
	})

	beforeEach(async () => {
		await clearFleet()
		await clearTasks()
		await clearSecrets()
	})

	async function expectRefused(input: LaunchInput, error: string) {
		const result = await launchCloudAgent(env, input)
		expect(result).toMatchObject({ ok: false, error })
		expect(await listCloudAgents(env.FERMI_DB)).toEqual([])
		expect(await listTasks(env.FERMI_DB, {})).toEqual([])
	}

	it('refuses an account on a non-claude route', async () => {
		await expectRefused(
			{ ...base, route: 'codex', account: 'alt' },
			'account_requires_claude_route',
		)
		await expectRefused({ ...base, route: 'grok', account: 'alt' }, 'account_requires_claude_route')
	})

	it('refuses malformed ids, including non-strings from the admin endpoint', async () => {
		for (const account of ['', 'Alt', '1alt', '_alt', 'a-b', 'alt\n', 'a'.repeat(33)]) {
			await expectRefused({ ...base, account }, 'invalid_account')
		}
		await expectRefused({ ...base, account: ['alt'] as unknown as string }, 'invalid_account')
		await expectRefused({ ...base, account: null as unknown as string }, 'invalid_account')
	})

	it('refuses an account whose secret is missing, even with a default token set', async () => {
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN', scope: 'app', value: 'default' }, env)
		await expectRefused({ ...base, account: 'alt' }, 'account_token_not_configured')
	})

	it('stores the account on the agent row, with the route defaulting to claude', async () => {
		await putSecret({ name: 'CLAUDE_CODE_OAUTH_TOKEN_WORK_2', scope: 'app', value: 'alt' }, env)
		await registerBox(env.FERMI_DB, { boxId: 'private-1', provider: 'private' })
		const result = await launchCloudAgent(env, {
			...base,
			box_id: 'private-1',
			account: 'work_2',
		})
		if (!result.ok) throw new Error(result.error)
		const row = await getCloudAgent(env.FERMI_DB, result.agent_id)
		expect(row).toMatchObject({ route: 'claude', account: 'work_2' })
	})

	it('leaves the column null without an account', async () => {
		await registerBox(env.FERMI_DB, { boxId: 'private-1', provider: 'private' })
		const result = await launchCloudAgent(env, { ...base, box_id: 'private-1' })
		if (!result.ok) throw new Error(result.error)
		expect((await getCloudAgent(env.FERMI_DB, result.agent_id))?.account).toBeNull()
	})

	it('exposes the id pattern on the MCP schema', () => {
		const schema = z.object(cloudAgentLaunchSchema)
		expect(schema.safeParse({ ...base, account: 'work_2' }).success).toBe(true)
		expect(schema.safeParse({ ...base, account: 'Work' }).success).toBe(false)
	})
})
