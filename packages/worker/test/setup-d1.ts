import { applyD1Migrations, env } from 'cloudflare:test'

// Tests run against the real migrations, so the schema cannot drift from them.
// applyD1Migrations is idempotent; every setup* call is the same operation.
async function setupSchema(): Promise<void> {
	await applyD1Migrations(env.FERMI_DB, env.TEST_MIGRATIONS)
}

async function clear(...tables: string[]): Promise<void> {
	await env.FERMI_DB.batch(tables.map((t) => env.FERMI_DB.prepare(`DELETE FROM ${t}`)))
}

export const setupAllowlistSchema = setupSchema
export const setupAuditSchema = setupSchema
export const setupFleetSchema = setupSchema
export const setupMemorySchema = setupSchema
export const setupOutboxSchema = setupSchema
export const setupProfileSchema = setupSchema
export const setupSchedulesSchema = setupSchema
export const setupSecretsSchema = setupSchema
export const setupSessionsSchema = setupSchema
export const setupSkillsSchema = setupSchema
export const setupTasksSchema = setupSchema
export const setupWebSessionSchema = setupSchema

export const clearAllowlist = () => clear('allowlist')
export const clearAudit = () => clear('audit')
export const clearFleet = () => clear('cloud_agents', 'boxes')
export const clearMemory = () => clear('memory')
export const clearOutbox = () => clear('outbox')
export const clearProfile = () => clear('profile_docs')
export const clearSchedules = () => clear('schedules')
export const clearSecrets = () => clear('secrets')
// 0002 seeds a message before 0003 adds the FTS triggers, so the index must be
// rebuilt before the delete trigger can remove that row.
export const clearSessions = async () => {
	await env.FERMI_DB.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run()
	await clear('messages', 'sessions')
}
export const clearSkills = () => clear('skills')
export const clearTasks = () => clear('tasks')
export const clearWebSessions = () => clear('web_session_leases', 'web_sessions')
