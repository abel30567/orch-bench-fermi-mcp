import { applyD1Migrations, env } from 'cloudflare:test'

/**
 * Schema helpers for D1-backed tests. Every setup applies the real migration
 * set (tracked, so repeat calls are no-ops); clears wipe one feature's tables.
 */
async function migrate(): Promise<void> {
	await applyD1Migrations(env.FERMI_DB, env.TEST_MIGRATIONS)
}

async function clear(...tables: string[]): Promise<void> {
	await env.FERMI_DB.batch(tables.map((t) => env.FERMI_DB.prepare(`DELETE FROM ${t}`)))
}

export const setupMemorySchema = migrate
export const setupSessionsSchema = migrate
export const setupAuditSchema = migrate
export const setupSecretsSchema = migrate
export const setupSkillsSchema = migrate
export const setupTasksSchema = migrate
export const setupProfileSchema = migrate
export const setupSchedulesSchema = migrate
export const setupOutboxSchema = migrate
export const setupAllowlistSchema = migrate
export const setupFleetSchema = migrate
export const setupWebSessionSchema = migrate

export const clearMemory = () => clear('memory')
// The 0002 seed message predates the 0003 FTS triggers, so it is missing from
// messages_fts; deleting it through the trigger corrupts the index. Rebuild first.
export const clearSessions = async () => {
	await env.FERMI_DB.prepare("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')").run()
	await clear('messages', 'sessions')
}
export const clearAudit = () => clear('audit')
export const clearSecrets = () => clear('secrets')
export const clearSkills = () => clear('skills')
export const clearTasks = () => clear('tasks')
export const clearProfile = () => clear('profile_docs')
export const clearSchedules = () => clear('schedules')
export const clearOutbox = () => clear('outbox')
export const clearAllowlist = () => clear('allowlist')
export const clearFleet = () => clear('cloud_agents', 'boxes')
export const clearWebSessions = () => clear('web_session_leases', 'web_sessions')
