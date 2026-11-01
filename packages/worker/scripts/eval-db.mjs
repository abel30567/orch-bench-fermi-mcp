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
 * Conversation turns for one chat, written to the same rows as
 * logChannelMessage (src/lib/conversation.ts): the chat's newest open session
 * on host `<channel>:<chat_id>` (created like createSession if none is open),
 * then one `messages` row per turn, which the FTS triggers index for
 * session_search. Each turn is stamped `now - minutes_ago` and inserted oldest
 * first, as live turns would have been. With `sender`, user turns carry the
 * group-chat attribution prefix the channel webhooks add (`[sender] text`).
 * The chat's previous sessions and messages are cleared first.
 */
function historyStatements(fixture, now) {
	const { channel, chat_id: chatId, sender, history } = fixture
	if (!CHANNELS.includes(channel) || typeof chatId !== 'string' || !chatId) {
		throw new Error(
			`fixture.history needs channel (one of ${CHANNELS.join(', ')}) and a non-empty chat_id`,
		)
	}
	if (!Array.isArray(history)) throw new Error('fixture.history must be an array')
	const turns = history.map((turn, i) => {
		const { role, text, minutes_ago: minutesAgo } = turn ?? {}
		if (role !== 'user' && role !== 'assistant') {
			throw new Error(`fixture.history[${i}].role must be "user" or "assistant"`)
		}
		if (typeof text !== 'string') throw new Error(`fixture.history[${i}].text must be a string`)
		if (typeof minutesAgo !== 'number' || !Number.isFinite(minutesAgo) || minutesAgo < 0) {
			throw new Error(`fixture.history[${i}].minutes_ago must be a number >= 0`)
		}
		const body = role === 'user' && sender ? `[${sender}] ${text}` : text
		return { role, body, createdAt: Math.round(now - minutesAgo * 60_000), i }
	})
	turns.sort((a, b) => a.createdAt - b.createdAt || a.i - b.i)

	const host = sql(`${channel}:${chatId}`)
	const openSession = `(SELECT id FROM sessions WHERE host = ${host} AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1)`
	const out = [
		`DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE host = ${host})`,
		`DELETE FROM sessions WHERE host = ${host}`,
	]
	if (turns.length === 0) return out
	out.push(
		`INSERT INTO sessions (id, host, mode, started_at) VALUES (${sql(crypto.randomUUID())}, ${host}, 'chat', ${turns[0].createdAt})`,
	)
	for (const t of turns) {
		out.push(
			`INSERT INTO messages (session_id, role, body, created_at) VALUES (${openSession}, ${sql(t.role)}, ${sql(t.body)}, ${t.createdAt})`,
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
	history:
		"SELECT s.host, m.role, m.body, m.created_at FROM messages m JOIN sessions s ON m.session_id = s.id WHERE substr(s.host, 3, 1) = ':' AND substr(s.host, 1, 2) IN ('tg', 'wa', 'dc', 'sl') ORDER BY m.created_at, m.id",
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
