import { applyD1Migrations, env } from 'cloudflare:test'

// Every schema helper applies the real migrations (idempotent: applied ones
// are tracked in d1_migrations), so tests always run against production DDL.
async function migrate(): Promise<void> {
	await applyD1Migrations(env.FERMI_DB, env.TEST_MIGRATIONS)
	// 0002 seeds messages before 0003 adds the FTS sync triggers; rebuild so
	// the trigger-driven FTS 'delete' on those rows doesn't corrupt the index.
	await env.FERMI_DB.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
}

async function clear(...tables: string[]): Promise<void> {
	await env.FERMI_DB.batch(tables.map((t) => env.FERMI_DB.prepare(`DELETE FROM ${t}`)))
}

export const setupAllowlistSchema = migrate
export const setupAuditSchema = migrate
export const setupFleetSchema = migrate
export const setupMemorySchema = migrate
export const setupOutboxSchema = migrate
export const setupProfileSchema = migrate
export const setupSchedulesSchema = migrate
export const setupSecretsSchema = migrate
export const setupSessionsSchema = migrate
export const setupSkillsSchema = migrate
export const setupTasksSchema = migrate
export const setupWebSessionSchema = migrate

export const clearAllowlist = () => clear('allowlist')
export const clearAudit = () => clear('audit')
export const clearFleet = () => clear('cloud_agents', 'boxes')
export const clearMemory = () => clear('memory')
export const clearOutbox = () => clear('outbox')
export const clearProfile = () => clear('profile_docs')
export const clearSchedules = () => clear('schedules')
export const clearSecrets = () => clear('secrets')
export const clearSessions = () => clear('messages', 'sessions')
export const clearSkills = () => clear('skills')
export const clearTasks = () => clear('tasks')
export const clearWebSessions = () => clear('web_session_leases', 'web_sessions')
