import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { searchMessages } from '../src/lib/session-store.ts'
import { applyMigrations } from './setup-d1.ts'

describe('messages FTS index', () => {
	beforeAll(async () => {
		await applyMigrations()
	})

	it('applies 0002_seed.sql and indexes the seeded message', async () => {
		const names = env.TEST_MIGRATIONS.map((m) => m.name)
		expect(names).toContain('0002_seed.sql')
		const seeded = await env.FERMI_DB.prepare(
			"SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'Hello'",
		).all<{ rowid: number }>()
		expect(seeded.results.map((r) => r.rowid)).toContain(1)
	})

	it('deletes the seeded message without corrupting the index', async () => {
		await env.FERMI_DB.prepare('DELETE FROM messages WHERE id = 1').run()
		const left = await env.FERMI_DB.prepare(
			'SELECT COUNT(*) AS n FROM messages WHERE id = 1',
		).first<{
			n: number
		}>()
		expect(left?.n).toBe(0)
		const check = await env.FERMI_DB.prepare(
			"INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)",
		).run()
		expect(check.success).toBe(true)
	})

	it('still finds messages inserted after the migrations', async () => {
		await env.FERMI_DB.prepare(
			"INSERT INTO messages (session_id, role, body, created_at) VALUES ('seed-session-001', 'user', 'quasar telescope', 1)",
		).run()
		const hits = await searchMessages('quasar', 10, env)
		expect(hits.map((h) => h.body)).toContain('quasar telescope')
	})
})
