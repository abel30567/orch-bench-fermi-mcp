const APPROVAL_TOKEN_TTL_MS = 300_000

/** Mints a token bound to this tool and args. D1 has no TTL, so each mint sweeps expired rows. */
export async function mintApprovalToken(
	db: D1Database,
	tool: string,
	argsHash: string,
): Promise<string> {
	const token = crypto.randomUUID()
	const now = Date.now()
	await db.batch([
		db.prepare('DELETE FROM approval_tokens WHERE expires_at <= ?1').bind(now),
		db
			.prepare(
				'INSERT INTO approval_tokens (token, tool, args_hash, expires_at) VALUES (?1, ?2, ?3, ?4)',
			)
			.bind(token, tool, argsHash, now + APPROVAL_TOKEN_TTL_MS),
	])
	return token
}

/**
 * Consumes a token. The single DELETE is the atomic step: of any number of
 * concurrent redeems, exactly one sees a change. A token presented for another
 * tool or other args matches no row, so it stays redeemable by the minted call.
 */
export async function redeemApprovalToken(
	db: D1Database,
	token: string,
	tool: string,
	argsHash: string,
): Promise<boolean> {
	const res = await db
		.prepare(
			'DELETE FROM approval_tokens WHERE token = ?1 AND tool = ?2 AND args_hash = ?3 AND expires_at > ?4',
		)
		.bind(token, tool, argsHash, Date.now())
		.run()
	return (res.meta.changes ?? 0) > 0
}
