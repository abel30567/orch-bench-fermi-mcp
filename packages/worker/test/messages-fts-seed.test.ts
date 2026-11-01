import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from './setup-d1.ts'

async function ftsMatch(term: string): Promise<number[]> {
	const { results } = await env.FERMI_DB.prepare(
		'SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid',
	)
		.bind(term)
		.all<{ id: number }>()
	return results.map((r) => r.id)
}

describe('messages FTS index with 0002 seed applied', () => {
	beforeAll(async () => {
		await applyMigrations()
	})

	it('applies 0002_seed.sql and indexes the seeded message', async () => {
		const row = await env.FERMI_DB.prepare('SELECT body FROM messages WHERE id = 1').first<{
			body: string
		}>()
		expect(row?.body).toBe('Hello Fermi!')
		expect(await ftsMatch('Hello')).toEqual([1])
	})

	it('deletes the seeded message without corrupting the FTS index', async () => {
		await env.FERMI_DB.prepare('DELETE FROM messages WHERE id = 1').run()
		const row = await env.FERMI_DB.prepare('SELECT id FROM messages WHERE id = 1').first()
		expect(row).toBeNull()
		expect(await ftsMatch('Hello')).toEqual([])
		await env.FERMI_DB.prepare(
			"INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')",
		).run()
	})

	it('finds messages inserted after migrations', async () => {
		await env.FERMI_DB.prepare(
			"INSERT INTO messages (id, session_id, role, body, created_at) VALUES (42, 'seed-session-001', 'user', 'zebra crossing', 0)",
		).run()
		expect(await ftsMatch('zebra')).toEqual([42])
	})
})
