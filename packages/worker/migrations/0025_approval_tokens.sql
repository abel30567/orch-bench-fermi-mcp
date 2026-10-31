-- Approval tokens move from KV to D1: a single DELETE redeems a token atomically,
-- so concurrent redeems of one token cannot both pass. expires_at is epoch ms,
-- 300 s after minting; D1 has no TTL, so minting purges expired rows.
CREATE TABLE IF NOT EXISTS approval_tokens (
	token TEXT PRIMARY KEY,
	tool TEXT NOT NULL,
	args_hash TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_tokens_expires_at ON approval_tokens(expires_at);
