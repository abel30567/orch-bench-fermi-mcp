import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { searchMessages } from '../src/lib/session-store.ts'
import { applyMigrations } from './setup-d1.ts'

describe('messages FTS index after all migrations (incl. 0002 seed)', () => {
	beforeAll(async () => {
		await applyMigrations()
	})

	it('applies 0002_seed.sql', async () => {
		const names = env.TEST_MIGRATIONS.map((m) => m.name)
		expect(names).toContain('0002_seed.sql')
		const row = await env.FERMI_DB.prepare('SELECT body FROM messages WHERE id = 1').first<{
			body: string
		}>()
		expect(row?.body).toBe('Hello Fermi!')
	})

	it('indexes the seeded message', async () => {
		const hits = await searchMessages('Hello', 10, env)
		expect(hits.map((m) => m.id)).toContain(1)
	})

	it('deletes the seeded message without corrupting the index', async () => {
		await env.FERMI_DB.prepare('DELETE FROM messages WHERE id = 1').run()
		const row = await env.FERMI_DB.prepare('SELECT id FROM messages WHERE id = 1').first()
		expect(row).toBeNull()
		const check = await env.FERMI_DB.prepare(
			"INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)",
		).run()
		expect(check.success).toBe(true)
		expect(await searchMessages('Hello', 10, env)).toEqual([])
	})

	it('finds messages inserted after migrations', async () => {
		await env.FERMI_DB.prepare(
			"INSERT INTO messages (session_id, role, body, created_at) VALUES ('seed-session-001', 'user', 'quasar telemetry', 1)",
		).run()
		const hits = await searchMessages('quasar', 10, env)
		expect(hits.map((m) => m.body)).toEqual(['quasar telemetry'])
	})
})
