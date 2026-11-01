// Conversation history seeding shared by eval-seed.mjs and the tests. Imports
// the worker's real conversation store, so seeded turns take the same code path
// (and D1 tables) as the channel webhooks and `channel_send`. Node runs the .ts
// import natively (type stripping, Node >= 22.18 / 23.6).

import { channelHost, logChannelMessage } from '../src/lib/conversation.ts'

/**
 * The chat a fixture's `history` belongs to: top-level `channel` / `chat_id` /
 * `sender`, falling back to the fixture's first task (the scenario's inbound).
 */
export function historyChat(fixture) {
	const task = fixture.tasks?.[0] ?? {}
	const channel = fixture.channel ?? task.channel
	const chatId = fixture.chat_id ?? task.chat_id
	if (!channel || !chatId) throw new Error('fixture.history needs channel and chat_id')
	return { channel, chatId, sender: fixture.sender }
}

/**
 * Seed `fixture.history` ([{ role: 'user'|'assistant', text, minutes_ago }])
 * through the real conversation store (`logChannelMessage`, the same code path
 * as the channel webhooks and `channel_send`), each turn stamped `minutes_ago`
 * before `now`. The chat's existing sessions and messages are removed first, so
 * a re-seed leaves exactly the fixture. With `sender`, user turns carry the
 * group-chat attribution prefix (`[sender] text`) the channel handlers add.
 */
export async function seedHistory(db, fixture, now = Date.now()) {
	if (!fixture.history) return 0
	const { channel, chatId, sender } = historyChat(fixture)
	const host = channelHost(channel, chatId)
	await db.batch([
		db
			.prepare('DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE host = ?1)')
			.bind(host),
		db.prepare('DELETE FROM sessions WHERE host = ?1').bind(host),
	])
	const turns = fixture.history
		.map((turn, i) => {
			if (turn.role !== 'user' && turn.role !== 'assistant') {
				throw new Error(`history[${i}].role must be user or assistant`)
			}
			if (typeof turn.text !== 'string' || typeof turn.minutes_ago !== 'number') {
				throw new Error(`history[${i}] needs text and a numeric minutes_ago`)
			}
			return { ...turn, at: Math.round(now - turn.minutes_ago * 60_000), i }
		})
		.sort((a, b) => a.at - b.at || a.i - b.i)
	for (const turn of turns) {
		const body = turn.role === 'user' && sender ? `[${sender}] ${turn.text}` : turn.text
		await logChannelMessage(db, channel, chatId, turn.role, body, turn.at)
	}
	return turns.length
}
