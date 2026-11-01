-- Single-use approval tokens for high-risk tools. Moved from KV so redemption is
-- one atomic DELETE ... RETURNING: concurrent redeems of one token yield one success.
-- expires_at is epoch milliseconds, 300 s after minting.
CREATE TABLE IF NOT EXISTS approval_tokens (
	token TEXT PRIMARY KEY,
	tool TEXT NOT NULL,
	args_hash TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_tokens_expires ON approval_tokens(expires_at);
