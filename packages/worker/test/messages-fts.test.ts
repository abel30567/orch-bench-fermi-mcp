import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from './setup-d1.ts'

describe('messages FTS index after all migrations', () => {
	beforeAll(async () => {
		await applyMigrations()
	})

	it('indexes the seeded message, so deleting it succeeds', async () => {
		const seeded = await env.FERMI_DB.prepare('SELECT id FROM messages WHERE id = 1').first()
		expect(seeded).not.toBeNull()

		const hit = await env.FERMI_DB.prepare(
			"SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'Fermi'",
		).first<{ rowid: number }>()
		expect(hit?.rowid).toBe(1)

		await env.FERMI_DB.prepare('DELETE FROM messages WHERE id = 1').run()
		const check = await env.FERMI_DB.prepare(
			"INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')",
		).run()
		expect(check.success).toBe(true)
	})

	it('still finds messages inserted after migrations', async () => {
		await env.FERMI_DB.prepare(
			"INSERT INTO messages (session_id, role, body, created_at) VALUES ('seed-session-001', 'user', 'zebra crossing', 0)",
		).run()
		const hit = await env.FERMI_DB.prepare(
			"SELECT m.body FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH 'zebra'",
		).first<{ body: string }>()
		expect(hit?.body).toBe('zebra crossing')
	})
})
