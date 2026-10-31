import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from './setup-d1.ts'

// Runs against every migration, 0002_seed.sql included (see vitest.config.ts).
describe('messages_fts after all migrations', () => {
	beforeAll(async () => {
		await applyMigrations()
	})

	it('indexes the seeded message so deleting it does not corrupt the FTS index', async () => {
		const hit = await env.FERMI_DB.prepare(
			"SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'Fermi'",
		).first<{ rowid: number }>()
		expect(hit?.rowid).toBe(1)

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

	it('still finds messages inserted after migrations', async () => {
		await env.FERMI_DB.prepare(
			"INSERT INTO messages (session_id, role, body, created_at) VALUES ('seed-session-001', 'user', 'quokka sighting', 1)",
		).run()
		const hit = await env.FERMI_DB.prepare(
			"SELECT m.body FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH 'quokka'",
		).first<{ body: string }>()
		expect(hit?.body).toBe('quokka sighting')
	})
})
