-- Single-use approval tokens for high-risk tools. Redemption is one conditional
-- DELETE ... RETURNING, so concurrent redeems of a token cannot both succeed
-- (KV get-then-delete could). expires_at is epoch ms, 300 s after minting.
CREATE TABLE IF NOT EXISTS approval_tokens (
	token TEXT PRIMARY KEY,
	tool TEXT NOT NULL,
	args_hash TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_tokens_expires ON approval_tokens(expires_at);
