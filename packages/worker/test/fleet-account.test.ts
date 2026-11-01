import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { launchCloudAgent } from '../src/lib/fleet-launch.ts'
import { clearSecrets, setupFleetSchema, setupSecretsSchema } from './setup-d1.ts'

const base = {
	prompt: 'build the thing please',
	proof_contract: JSON.stringify({ kind: 'artifact', name: 'out.diff', min_bytes: 1 }),
}

describe('launchCloudAgent account validation', () => {
	beforeAll(async () => {
		await setupFleetSchema()
		await setupSecretsSchema()
	})
	beforeEach(async () => {
		await clearSecrets()
	})

	it('rejects an account on a non-claude route', async () => {
		expect(await launchCloudAgent(env, { ...base, route: 'codex', account: 'alt' })).toMatchObject({
			ok: false,
			error: 'account_requires_claude_route',
		})
	})

	it('rejects a malformed account id', async () => {
		for (const account of ['Alt', '1alt', 'a-b', '', 'a'.repeat(33)]) {
			expect(await launchCloudAgent(env, { ...base, account })).toMatchObject({
				ok: false,
				error: 'invalid_account',
			})
		}
	})

	it('rejects an account whose token secret is missing', async () => {
		expect(await launchCloudAgent(env, { ...base, account: 'alt_two' })).toMatchObject({
			ok: false,
			error: 'account_token_not_configured',
			secret: 'CLAUDE_CODE_OAUTH_TOKEN_ALT_TWO',
		})
	})
})
