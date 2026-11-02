// SQL and MCP calls shared by eval-seed.mjs and eval-dump.mjs. No Node imports,
// so the tests can run the same statements and calls against the test worker.

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
	if (fixture.history) out.push(...historyStatements(fixture, now))
	return out
}

const CHANNELS = ['tg', 'wa', 'dc', 'sl']

/**
 * Conversation history for one chat, written to the same rows the channel
 * webhooks write via logChannelMessage (src/lib/conversation.ts): one open
 * `sessions` row with host `<channel>:<chat_id>` (getOrCreateChannelSession
 * picks it up for later turns), and one `messages` row per turn (the FTS
 * triggers index them for session_search). Each turn is stamped
 * `minutes_ago` before seed time. The chat's previous history is cleared.
 * `sender` is the inbound sender id; production logs DM turns without it, so
 * it is validated but does not change the rows.
 */
function historyStatements(fixture, now) {
	const { channel, chat_id: chatId, sender, history } = fixture
	if (!CHANNELS.includes(channel)) {
		throw new Error(`history: channel must be one of ${CHANNELS.join(', ')}, got ${channel}`)
	}
	if (typeof chatId !== 'string' || !chatId) throw new Error('history: chat_id is required')
	if (sender !== undefined && typeof sender !== 'string') {
		throw new Error('history: sender must be a string')
	}
	if (!Array.isArray(history)) throw new Error('history: must be an array of turns')
	const turns = history.map((t, i) => {
		if (t.role !== 'user' && t.role !== 'assistant') {
			throw new Error(`history[${i}]: role must be user or assistant`)
		}
		if (typeof t.text !== 'string') throw new Error(`history[${i}]: text must be a string`)
		if (typeof t.minutes_ago !== 'number' || !(t.minutes_ago >= 0)) {
			throw new Error(`history[${i}]: minutes_ago must be a number >= 0`)
		}
		return { ...t, created_at: Math.round(now - t.minutes_ago * 60_000) }
	})
	const host = sql(`${channel}:${chatId}`)
	const out = [
		`DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE host = ${host})`,
		`DELETE FROM sessions WHERE host = ${host}`,
	]
	if (turns.length === 0) return out
	const sessionId = sql(crypto.randomUUID())
	const startedAt = Math.min(...turns.map((t) => t.created_at))
	out.push(
		`INSERT INTO sessions (id, host, mode, started_at) VALUES (${sessionId}, ${host}, 'chat', ${startedAt})`,
	)
	for (const t of turns) {
		out.push(
			`INSERT INTO messages (session_id, role, body, created_at) VALUES (${sessionId}, ${sql(t.role)}, ${sql(t.text)}, ${t.created_at})`,
		)
	}
	return out
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
	// Channel chats only (host `<channel>:<chat_id>`), not MCP session tool logs.
	history: `SELECT s.host, m.role, m.body, m.created_at FROM messages m JOIN sessions s ON m.session_id = s.id
		WHERE substr(s.host, 1, 3) IN ('tg:', 'wa:', 'dc:', 'sl:') ORDER BY s.host, m.created_at, m.id`,
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
