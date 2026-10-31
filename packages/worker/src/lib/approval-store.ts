export const APPROVAL_TOKEN_TTL_MS = 300_000

export async function mintApprovalToken(
	db: D1Database,
	tool: string,
	argsHash: string,
	now = Date.now(),
): Promise<string> {
	const token = crypto.randomUUID()
	await db
		.prepare(
			'INSERT INTO approval_tokens (token, tool, args_hash, expires_at) VALUES (?1, ?2, ?3, ?4)',
		)
		.bind(token, tool, argsHash, now + APPROVAL_TOKEN_TTL_MS)
		.run()
	return token
}

/**
 * Consume a token in one statement, so of any number of concurrent redeems exactly
 * one deletes the row. A token presented for another tool or other args is left in place.
 */
export async function redeemApprovalToken(
	db: D1Database,
	token: string,
	tool: string,
	argsHash: string,
	now = Date.now(),
): Promise<boolean> {
	const { meta } = await db
		.prepare(
			'DELETE FROM approval_tokens WHERE token = ?1 AND tool = ?2 AND args_hash = ?3 AND expires_at > ?4',
		)
		.bind(token, tool, argsHash, now)
		.run()
	return meta.changes === 1
}

/** D1 has no TTL: drop what KV would have expired on its own. */
export async function purgeExpiredApprovalTokens(
	db: D1Database,
	now = Date.now(),
): Promise<number> {
	const { meta } = await db
		.prepare('DELETE FROM approval_tokens WHERE expires_at <= ?1')
		.bind(now)
		.run()
	return meta.changes
}
