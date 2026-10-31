import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { searchMessages } from '../src/lib/session-store.ts'
import { applyMigrations } from './setup-d1.ts'

const SEED_ID = 1

beforeAll(async () => {
	await applyMigrations()
})

async function ftsRowids(term: string) {
	const { results } = await env.FERMI_DB.prepare(
		'SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?1',
	)
		.bind(term)
		.all<{ rowid: number }>()
	return results.map((r) => r.rowid)
}

describe('messages_fts after all migrations', () => {
	it('applies 0002_seed.sql, so the seeded message exists', () => {
		expect(env.TEST_MIGRATIONS.map((m) => m.name)).toContain('0002_seed.sql')
	})

	it('indexes the seeded message and passes the FTS integrity check', async () => {
		expect(await ftsRowids('Fermi')).toEqual([SEED_ID])
		await env.FERMI_DB.prepare(
			"INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')",
		).run()
	})

	it('deletes the seeded message without corrupting the index', async () => {
		await env.FERMI_DB.prepare('DELETE FROM messages WHERE id = ?1').bind(SEED_ID).run()
		const row = await env.FERMI_DB.prepare('SELECT id FROM messages WHERE id = ?1')
			.bind(SEED_ID)
			.first()
		expect(row).toBeNull()
		expect(await ftsRowids('Fermi')).toEqual([])
	})

	it('still finds messages inserted after the migrations', async () => {
		await env.FERMI_DB.prepare(
			"INSERT INTO messages (session_id, role, body, created_at) VALUES ('seed-session-001', 'user', 'zebra crossing', 0)",
		).run()
		const found = await searchMessages('zebra', 5, env)
		expect(found.map((m) => m.body)).toEqual(['zebra crossing'])
	})
})
