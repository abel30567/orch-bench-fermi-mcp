-- Approval tokens for high-risk tools (moved from KV). Redemption is a single
-- DELETE ... RETURNING, which is atomic in D1: of N concurrent redeems of one
-- token exactly one gets the row back. expires_at is epoch ms (mint + 300 s),
-- mirroring the former KV expirationTtl of 300 s.
CREATE TABLE IF NOT EXISTS approval_tokens (
	token TEXT PRIMARY KEY,
	tool TEXT NOT NULL,
	args_hash TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_tokens_expires ON approval_tokens(expires_at);
