import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { searchMessages } from '../src/lib/session-store.ts'
import { applyMigrations } from './setup-d1.ts'

describe('messages_fts after all migrations (including 0002_seed.sql)', () => {
	beforeAll(async () => {
		await applyMigrations()
	})

	it('indexes the seeded message and deletes it without corrupting the index', async () => {
		const seeded = await env.FERMI_DB.prepare('SELECT id FROM messages WHERE id = 1').first<{
			id: number
		}>()
		expect(seeded?.id).toBe(1)
		expect((await searchMessages('Fermi', 10, env)).map((m) => m.id)).toContain(1)

		await env.FERMI_DB.prepare('DELETE FROM messages WHERE id = 1').run()

		expect(await searchMessages('Fermi', 10, env)).toEqual([])
		const check = env.FERMI_DB.prepare(
			"INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)",
		).run()
		await expect(check).resolves.toBeDefined()
	})

	it('still finds messages inserted after migrations', async () => {
		await env.FERMI_DB.prepare(
			"INSERT INTO messages (session_id, role, body, created_at) VALUES ('seed-session-001', 'user', 'quokka sighting', 0)",
		).run()
		const hits = await searchMessages('quokka', 10, env)
		expect(hits.map((m) => m.body)).toEqual(['quokka sighting'])
	})
})
