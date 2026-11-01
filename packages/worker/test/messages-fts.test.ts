import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { searchMessages } from '../src/lib/session-store.ts'
import { applyMigrations } from './setup-d1.ts'

// 0002_seed.sql inserts message 1 before 0003 adds the FTS sync triggers; 0024 rebuilds the index.
describe('messages_fts after all migrations (including 0002 seed)', () => {
	beforeAll(async () => {
		await applyMigrations()
	})

	it('applies the seed migration in tests', () => {
		expect(env.TEST_MIGRATIONS.map((m) => m.name)).toContain('0002_seed.sql')
	})

	it('indexes the seeded message and passes the FTS integrity check', async () => {
		const seeded = await env.FERMI_DB.prepare('SELECT body FROM messages WHERE id = 1').first<{
			body: string
		}>()
		expect(seeded?.body).toBe('Hello Fermi!')
		const hits = await searchMessages('Fermi', 10, env as unknown as Env)
		expect(hits.map((h) => h.id)).toContain(1)
		await env.FERMI_DB.prepare(
			"INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)",
		).run()
	})

	it('deletes the seeded message without corrupting the index', async () => {
		await env.FERMI_DB.prepare('DELETE FROM messages WHERE id = 1').run()
		const row = await env.FERMI_DB.prepare(
			'SELECT COUNT(*) AS n FROM messages WHERE id = 1',
		).first<{
			n: number
		}>()
		expect(row?.n).toBe(0)
		expect(await searchMessages('Fermi', 10, env as unknown as Env)).toEqual([])
		await env.FERMI_DB.prepare(
			"INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)",
		).run()
	})

	it('still finds messages inserted after migrations', async () => {
		await env.FERMI_DB.prepare(
			"INSERT INTO messages (session_id, role, body, created_at) VALUES ('seed-session-001', 'user', 'quantum widget', 0)",
		).run()
		const hits = await searchMessages('widget', 10, env as unknown as Env)
		expect(hits.map((h) => h.body)).toEqual(['quantum widget'])
	})
})
