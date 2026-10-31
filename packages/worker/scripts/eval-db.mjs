// SQL and MCP calls shared by eval-seed.mjs and eval-dump.mjs. No Node imports,
// so the tests can run the same statements and calls against the test worker.

const sql = (value) => {
	if (value === null || value === undefined) return 'NULL'
	if (typeof value === 'boolean') return value ? '1' : '0'
	if (typeof value === 'number') return String(value)
	return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * A text literal as hex. `wrangler d1 execute --file` strips "BEGIN TRANSACTION;"
 * and "COMMIT;" from the whole file, string literals included.
 */
const hexText = (value) => {
	const bytes = [...new TextEncoder().encode(value)]
	return `CAST(X'${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}' AS TEXT)`
}

const CHANNELS = ['tg', 'wa', 'dc', 'sl']

/** Refuse a history the tools could not read back, before anything is written. */
function assertHistory({ channel, chat_id: chatId, history }) {
	if (!CHANNELS.includes(channel)) {
		throw new Error(`fixture history needs channel ${CHANNELS.join('|')}, got ${channel}`)
	}
	if (typeof chatId !== 'string' || !chatId) throw new Error('fixture history needs chat_id')
	for (const [i, turn] of history.entries()) {
		if (turn.role !== 'user' && turn.role !== 'assistant') {
			throw new Error(`history[${i}].role must be user or assistant, got ${turn.role}`)
		}
		if (typeof turn.text !== 'string' || !turn.text) {
			throw new Error(`history[${i}].text must be a non-empty string`)
		}
		if (!Number.isFinite(turn.minutes_ago) || turn.minutes_ago < 0) {
			throw new Error(`history[${i}].minutes_ago must be a number >= 0`)
		}
	}
}

/**
 * The rows logChannelMessage leaves behind (one open 'chat' session on host
 * `channel:chat_id`, one message per turn), but backdated, which the store
 * cannot do. eval-seed-history.test.ts pins this to the real store. Inserts run
 * oldest first so message ids stay chronological, and the messages_fts triggers
 * index each turn. Each turn's text is the stored body, whatever the fixture's
 * `sender`: production picks DM or group from the webhook payload (is_im, guild_id),
 * not the chat id, and prefixes a display name, so neither can be derived here.
 * A group fixture writes the attribution in the text: "[Ana] hello".
 */
function historyStatements(fixture, now) {
	assertHistory(fixture)
	// plans and team_spawns reference sessions, so they go first.
	const out = [
		'DELETE FROM messages',
		'DELETE FROM plans',
		'DELETE FROM team_spawns',
		'DELETE FROM sessions',
	]
	const { channel, chat_id: chatId, history } = fixture
	if (history.length === 0) return out
	const turns = [...history]
		.sort((a, b) => b.minutes_ago - a.minutes_ago)
		.map((t) => ({ ...t, at: Math.round(now - t.minutes_ago * 60_000) }))
	const id = crypto.randomUUID()
	out.push(
		`INSERT INTO sessions (id, host, mode, started_at) VALUES (${sql(id)}, ${sql(`${channel}:${chatId}`)}, 'chat', ${turns[0].at})`,
	)
	for (const t of turns) {
		out.push(
			`INSERT INTO messages (session_id, role, body, created_at) VALUES (${sql(id)}, ${sql(t.role)}, ${hexText(t.text)}, ${t.at})`,
		)
	}
	return out
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
	history: `SELECT s.host, m.role, m.body, m.created_at
		FROM messages m JOIN sessions s ON m.session_id = s.id
		WHERE s.host LIKE 'tg:%' OR s.host LIKE 'wa:%' OR s.host LIKE 'dc:%' OR s.host LIKE 'sl:%'
		ORDER BY m.created_at, m.id`,
}

/**
 * Shape rows (one array per DUMP_QUERIES entry, same order) for assertions. A dump
 * is not a seed fixture: its history can span chats, so each turn names its own.
 */
export function shapeDump(rowSets, now = Date.now()) {
	const names = Object.keys(DUMP_QUERIES)
	const dump = Object.fromEntries(names.map((name, i) => [name, rowSets[i] ?? []]))
	dump.profile = Object.fromEntries(dump.profile.map((r) => [r.name, r.body]))
	dump.memories = dump.memories.map((m) => ({ ...m, pinned: m.pinned === 1 }))
	dump.history = dump.history.map((m) => ({
		channel: m.host.slice(0, m.host.indexOf(':')),
		chat_id: m.host.slice(m.host.indexOf(':') + 1),
		role: m.role,
		text: m.body,
		minutes_ago: (now - m.created_at) / 60_000,
		created_at: m.created_at,
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
