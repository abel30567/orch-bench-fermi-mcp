import { applyD1Migrations, env, fetchMock } from 'cloudflare:test'
import { beforeAll, beforeEach } from 'vitest'
import { macBridgeReply } from './fake-mac.ts'

// Runs before every contract test file. Storage is shared across files
// (isolatedStorage: false), so every test starts from migrated, empty D1 tables.

async function resetD1() {
	await applyD1Migrations(env.FERMI_DB, env.TEST_MIGRATIONS)
	// Plain tables only: FTS indexes follow their base tables through triggers.
	const { results } = await env.FERMI_DB.prepare(
		`SELECT name FROM sqlite_master
		 WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'
		   AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'
		   AND name NOT IN (SELECT name || suffix FROM sqlite_master, (
		     SELECT '_data' AS suffix UNION SELECT '_idx' UNION SELECT '_content'
		     UNION SELECT '_docsize' UNION SELECT '_config')
		     WHERE sql LIKE 'CREATE VIRTUAL TABLE%')`,
	).all<{ name: string }>()
	await env.FERMI_DB.batch([
		env.FERMI_DB.prepare('PRAGMA defer_foreign_keys = ON'),
		...results.map((t) => env.FERMI_DB.prepare(`DELETE FROM "${t.name}"`)),
	])
}

beforeEach(resetD1)

beforeAll(() => {
	// No contract test reaches the network: anything a test has not mocked fails.
	fetchMock.activate()
	fetchMock.disableNetConnect()

	// The macOS bridge answers through fake-mac.ts (503 unless a test installs a handler).
	fetchMock
		.get('http://mac.test')
		.intercept({ path: () => true, method: () => true })
		.reply((opts) => {
			const reply = macBridgeReply({
				path: opts.path,
				method: opts.method,
				headers: opts.headers,
				body: opts.body,
			})
			return {
				statusCode: reply.statusCode,
				data: reply.data ?? '',
				responseOptions: reply.responseOptions ?? {},
			}
		})
		.persist()
})
