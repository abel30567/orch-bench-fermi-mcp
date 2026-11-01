import { applyD1Migrations, env, fetchMock } from 'cloudflare:test'
import { beforeAll, beforeEach } from 'vitest'
import { macBridgeReply } from './fake-mac.ts'

// Runs for every contract test file. isolatedStorage is off (McpAgent Durable
// Objects keep state across requests), so D1 is reset here instead: every test
// starts from a freshly migrated database.

async function resetD1(): Promise<void> {
	const db = env.FERMI_DB
	const { results } = await db
		.prepare(
			`SELECT type, name, sql FROM sqlite_master
			 WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
			   AND type IN ('table', 'view', 'trigger')`,
		)
		.all<{ type: string; name: string; sql: string | null }>()
	const isVirtual = (r: { sql: string | null }) => /CREATE\s+VIRTUAL/i.test(r.sql ?? '')
	const virtuals = results.filter((r) => r.type === 'table' && isVirtual(r)).map((r) => r.name)
	// FTS shadow tables go away with their virtual table.
	const isShadow = (name: string) => virtuals.some((v) => name.startsWith(`${v}_`))
	const drops = [
		...results.filter((r) => r.type === 'trigger').map((r) => `DROP TRIGGER IF EXISTS "${r.name}"`),
		...results.filter((r) => r.type === 'view').map((r) => `DROP VIEW IF EXISTS "${r.name}"`),
		...virtuals.map((name) => `DROP TABLE IF EXISTS "${name}"`),
		...results
			.filter((r) => r.type === 'table' && !isVirtual(r) && !isShadow(r.name))
			.map((r) => `DROP TABLE IF EXISTS "${r.name}"`),
	]
	if (drops.length > 0) {
		await db.batch([
			db.prepare('PRAGMA defer_foreign_keys = ON'),
			...drops.map((sql) => db.prepare(sql)),
		])
	}
	await applyD1Migrations(db, env.TEST_MIGRATIONS)
}

beforeAll(() => {
	// Outbound HTTP is refused unless a test mocks it.
	fetchMock.activate()
	fetchMock.disableNetConnect()

	// The macOS bridge answers 503 unless a test installs a fake (fake-mac.ts).
	fetchMock
		.get('http://mac.test')
		.intercept({ path: () => true, method: () => true })
		.reply((opts) => {
			const reply = macBridgeReply({
				path: String(opts.path),
				method: String(opts.method),
				headers: opts.headers,
				body: opts.body,
			})
			return {
				statusCode: reply.statusCode,
				data: reply.data ?? '',
				responseOptions: reply.responseOptions,
			}
		})
		.persist()
})

beforeEach(resetD1)
