import { applyD1Migrations, env, fetchMock } from 'cloudflare:test'
import { beforeAll, beforeEach } from 'vitest'
import { macBridgeReply } from './fake-mac.ts'

// Runs before every contract test file. The schema comes only from
// migrations/*.sql; applyD1Migrations is idempotent across files.
// Outbound HTTP is refused unless a test mocks it, and the macOS bridge
// (http://mac.test) answers through macBridgeReply() (503 by default).
beforeAll(async () => {
	await applyD1Migrations(env.FERMI_DB, env.TEST_MIGRATIONS)
	fetchMock.activate()
	fetchMock.disableNetConnect()
	fetchMock
		.get('http://mac.test')
		.intercept({ path: () => true, method: () => true })
		.reply((opts) => macBridgeReply(opts))
		.persist()
})

// Storage is shared across tests (isolatedStorage is off for the McpAgent
// Durable Objects), so every test starts from empty D1 tables. FTS indexes
// follow their base tables through triggers.
beforeEach(async () => {
	const { results } = await env.FERMI_DB.prepare(
		`SELECT name FROM sqlite_master WHERE type = 'table'
		 AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '%_fts%'
		 AND name != 'd1_migrations' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'`,
	).all<{ name: string }>()
	await env.FERMI_DB.batch([
		env.FERMI_DB.prepare('PRAGMA defer_foreign_keys = ON'),
		...results.map((t) => env.FERMI_DB.prepare(`DELETE FROM "${t.name}"`)),
	])
})
