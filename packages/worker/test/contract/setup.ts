import { applyD1Migrations, env, fetchMock } from 'cloudflare:test'
import { beforeAll, beforeEach } from 'vitest'
import { macBridgeReply } from './fake-mac.ts'

/**
 * Isolated storage is off (see vitest.contract.config.ts), so empty every table
 * by hand. FTS tables follow their base tables through triggers; rows that
 * reference each other go in one batch with the foreign key check deferred.
 */
async function resetD1(): Promise<void> {
	const { results } = await env.FERMI_DB.prepare(
		`SELECT name FROM sqlite_master WHERE type = 'table'
		 AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
		 AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
		 AND name NOT LIKE '%\\_fts%' ESCAPE '\\'
		 AND name <> 'd1_migrations'`,
	).all<{ name: string }>()
	await env.FERMI_DB.batch([
		env.FERMI_DB.prepare('PRAGMA defer_foreign_keys = ON'),
		...results.map((r) => env.FERMI_DB.prepare(`DELETE FROM "${r.name}"`)),
	])
}

beforeEach(resetD1)

// Runs once per test file. The contract project shares one D1 across files, and
// applied migrations are recorded in d1_migrations, so this stays idempotent.
beforeAll(async () => {
	await applyD1Migrations(env.FERMI_DB, env.TEST_MIGRATIONS)
	fetchMock.activate()
	fetchMock.disableNetConnect()
	fetchMock
		.get('http://mac.test')
		.intercept({ path: () => true, method: () => true })
		.reply((opts) => {
			const { statusCode, data, responseOptions } = macBridgeReply(opts)
			return { statusCode, data: data ?? '', responseOptions }
		})
		.persist()
})
