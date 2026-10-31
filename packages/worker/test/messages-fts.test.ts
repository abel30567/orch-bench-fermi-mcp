import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from './setup-d1.ts'

const matchIds = async (term: string) => {
	const { results } = await env.FERMI_DB.prepare(
		'SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ?1 ORDER BY rowid',
	)
		.bind(term)
		.all<{ id: number }>()
	return results.map((r) => r.id)
}

describe('messages_fts after all migrations', () => {
	beforeEach(applyMigrations)

	it('applies 0002_seed.sql', () => {
		expect(env.TEST_MIGRATIONS.map((m) => m.name)).toContain('0002_seed.sql')
	})

	it('indexes the seeded message', async () => {
		expect(await matchIds('hello')).toEqual([1])
	})

	it('deletes the seeded message and drops it from the index', async () => {
		await env.FERMI_DB.prepare('DELETE FROM messages WHERE id = 1').run()

		expect(await env.FERMI_DB.prepare('SELECT id FROM messages WHERE id = 1').first()).toBeNull()
		expect(await matchIds('hello')).toEqual([])
	})

	it('updates the seeded message', async () => {
		await env.FERMI_DB.prepare("UPDATE messages SET body = 'Goodbye Fermi' WHERE id = 1").run()

		expect(await matchIds('hello')).toEqual([])
		expect(await matchIds('goodbye')).toEqual([1])
	})

	it('finds messages inserted after migrations', async () => {
		await env.FERMI_DB.prepare(
			"INSERT INTO messages (id, session_id, role, body, created_at) VALUES (2, 'seed-session-001', 'user', 'quokka sighting', 1)",
		).run()

		expect(await matchIds('quokka')).toEqual([2])
	})
})
