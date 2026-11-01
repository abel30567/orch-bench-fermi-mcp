// SQL and MCP calls shared by eval-seed.mjs and eval-dump.mjs. No Node imports,
// so the tests can run the same statements and calls against the test worker.

import { channelHost, logChannelMessage } from '../src/lib/conversation.ts'

const CHANNELS = ['tg', 'wa', 'dc', 'sl']
const ROLES = ['user', 'assistant']

const sql = (value) => {
	if (value === null || value === undefined) return 'NULL'
	if (typeof value === 'boolean') return value ? '1' : '0'
	if (typeof value === 'number') return String(value)
	return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * Statements that replace the eval-relevant state with the fixture's. Tables
 * the fixture names are cleared first, so a re-seed leaves exactly the fixture.
 */
export function seedStatements(fixture, now = Date.now()) {
	const out = []
	if (fixture.profile) {
		out.push('DELETE FROM profile_docs')
		for (const [name, body] of Object.entries(fixture.profile)) {
			out.push(
				`INSERT INTO profile_docs (name, body, updated_at) VALUES (${sql(name)}, ${sql(body)}, ${now})`,
			)
		}
	}
	if (fixture.memories) {
		out.push('DELETE FROM memory')
		for (const m of fixture.memories) {
			out.push(
				`INSERT INTO memory (kind, body, created_at, pinned) VALUES (${sql(m.kind)}, ${sql(m.body)}, ${sql(m.created_at ?? now)}, ${sql(m.pinned ?? false)})`,
			)
		}
	}
	if (fixture.allowlist) {
		out.push('DELETE FROM allowlist')
		for (const a of fixture.allowlist) {
			out.push(
				`INSERT INTO allowlist (channel, sender_id, note, added_at, added_by) VALUES (${sql(a.channel)}, ${sql(a.sender_id)}, ${sql(a.note)}, ${now}, 'eval-seed')`,
			)
		}
	}
	if (fixture.tasks) {
		out.push('DELETE FROM tasks')
		for (const [i, t] of fixture.tasks.entries()) {
			out.push(
				`INSERT INTO tasks (id, channel, sender, chat_id, payload, created_at, queue) VALUES (${sql(t.id)}, ${sql(t.channel)}, ${sql(t.sender)}, ${sql(t.chat_id)}, ${sql(t.payload)}, ${sql(t.created_at ?? now + i)}, ${sql(t.queue ?? 'main')})`,
			)
		}
	}
	if (fixture.history) {
		const { channel, chat_id } = historyTarget(fixture)
		// The fixture's history is the whole transcript state: clear every message,
		// and this chat's sessions so the seeded turns open a fresh one.
		out.push('DELETE FROM messages')
		out.push(`DELETE FROM sessions WHERE host = ${sql(channelHost(channel, chat_id))}`)
	}
	return out
}

/** Validated `{ channel, chat_id, history }` of a fixture with conversation history. */
function historyTarget(fixture) {
	const { channel, chat_id, sender, history } = fixture
	if (!CHANNELS.includes(channel)) {
		throw new Error(`fixture.history needs channel (one of ${CHANNELS.join(', ')})`)
	}
	if (typeof chat_id !== 'string' || !chat_id) throw new Error('fixture.history needs chat_id')
	if (sender !== undefined && (typeof sender !== 'string' || !sender)) {
		throw new Error('fixture.sender must be a non-empty string')
	}
	if (!Array.isArray(history)) throw new Error('fixture.history must be an array')
	for (const [i, turn] of history.entries()) {
		if (
			!ROLES.includes(turn?.role) ||
			typeof turn.text !== 'string' ||
			typeof turn.minutes_ago !== 'number' ||
			!(turn.minutes_ago >= 0)
		) {
			throw new Error(
				`fixture.history[${i}] must be { role: "user"|"assistant", text, minutes_ago >= 0 }`,
			)
		}
	}
	return { channel, chat_id, sender, history }
}

/**
 * Write the fixture's conversation history through the real conversation store
 * (`logChannelMessage`, as the channel webhooks and `channel_send` do), each turn
 * stamped `minutes_ago` before `now`. Run after seedStatements, which clears the
 * chat. `db` is a D1 binding: the test worker's, or the eval worker's local D1.
 * With `sender`, the turns must come from an allowlisted sender, as in production
 * where a non-allowlisted message is never logged.
 */
export async function seedHistory(db, fixture, now = Date.now()) {
	if (!fixture.history) return
	const { channel, chat_id, sender, history } = historyTarget(fixture)
	if (sender) {
		const allowed = await db
			.prepare('SELECT 1 FROM allowlist WHERE channel = ?1 AND sender_id = ?2')
			.bind(channel, sender)
			.first()
		if (!allowed) {
			throw new Error(`fixture.sender ${sender} is not on the ${channel} allowlist`)
		}
	}
	for (const turn of history) {
		const at = now - Math.round(turn.minutes_ago * 60_000)
		await logChannelMessage(db, channel, chat_id, turn.role, turn.text, at)
	}
}

/** One query per dumped section, in order. */
export const DUMP_QUERIES = {
	profile: 'SELECT name, body FROM profile_docs ORDER BY name',
	memories:
		'SELECT id, kind, body, pinned, created_at, decayed_at FROM memory ORDER BY created_at, id',
	allowlist: 'SELECT channel, sender_id, note FROM allowlist ORDER BY channel, sender_id',
	tasks: 'SELECT * FROM tasks ORDER BY created_at, id',
	outbox: 'SELECT * FROM outbox ORDER BY created_at, id',
	schedules: 'SELECT * FROM schedules ORDER BY created_at, id',
	skills:
		'SELECT slug, name, description, keywords, allowed_tools, version, source, decayed_at FROM skills ORDER BY slug',
	audit: 'SELECT * FROM audit ORDER BY id',
	// Channel chat transcripts only (sessions.host = '<channel>:<chat_id>'), not
	// the MCP sessions' tool-call log.
	history: `SELECT s.host, m.role, m.body, m.created_at
		FROM messages m JOIN sessions s ON m.session_id = s.id
		WHERE substr(s.host, 1, 3) IN (${CHANNELS.map((c) => sql(`${c}:`)).join(', ')})
		ORDER BY m.created_at, m.id`,
}

/** Shape rows (one array per DUMP_QUERIES entry, same order) like a fixture. */
export function shapeDump(rowSets) {
	const names = Object.keys(DUMP_QUERIES)
	const dump = Object.fromEntries(names.map((name, i) => [name, rowSets[i] ?? []]))
	dump.profile = Object.fromEntries(dump.profile.map((r) => [r.name, r.body]))
	dump.memories = dump.memories.map((m) => ({ ...m, pinned: m.pinned === 1 }))
	dump.history = dump.history.map(({ host, role, body, created_at }) => ({
		channel: host.slice(0, 2),
		chat_id: host.slice(3),
		role,
		text: body,
		created_at,
	}))
	return dump
}

/** First JSON-RPC message of a streamable-HTTP MCP response (JSON or SSE body). */
async function rpcReply(res) {
	const text = await res.text()
	if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text}`)
	const data = (res.headers.get('content-type') ?? '').includes('text/event-stream')
		? text
				.split(/\r?\n/)
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trimStart())[0]
		: text
	const reply = JSON.parse(data)
	if (reply.error) throw new Error(`MCP error ${reply.error.code}: ${reply.error.message}`)
	return reply.result
}

/**
 * Seed skills through the real `skill_set` tool over MCP, so bodies land in R2
 * and metadata in D1 exactly as in production. Each fixture skill is the tool's
 * arguments ({ slug, body, metadata? }). `mcpUrl` is the eval worker's /mcp
 * (auth is off there); `fetchFn` is swappable for tests.
 */
export async function seedSkills(skills, mcpUrl, fetchFn = fetch) {
	const headers = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	}
	let id = 0
	const post = (message) =>
		fetchFn(mcpUrl, {
			method: 'POST',
			headers,
			body: JSON.stringify({ jsonrpc: '2.0', ...message }),
		})
	const init = await post({
		id: ++id,
		method: 'initialize',
		params: {
			protocolVersion: '2025-03-26',
			capabilities: {},
			clientInfo: { name: 'fermi-eval-seed', version: '0.0.0' },
		},
	})
	await rpcReply(init)
	headers['mcp-session-id'] = init.headers.get('mcp-session-id')
	await (await post({ method: 'notifications/initialized' })).body?.cancel()
	for (const skill of skills) {
		const result = await rpcReply(
			await post({
				id: ++id,
				method: 'tools/call',
				params: { name: 'skill_set', arguments: skill },
			}),
		)
		if (result.isError) {
			throw new Error(`skill_set ${skill.slug}: ${JSON.stringify(result.content)}`)
		}
	}
}
