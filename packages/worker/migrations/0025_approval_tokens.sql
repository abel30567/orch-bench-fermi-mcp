-- Single-use approval tokens for high-risk tools. Moved from KV (get-then-delete,
-- eventually consistent) so redemption is one atomic DELETE ... RETURNING.
-- expires_at: epoch ms, 300 s after minting. tool/args_hash bind a token to its call.
CREATE TABLE IF NOT EXISTS approval_tokens (
	token TEXT PRIMARY KEY,
	tool TEXT NOT NULL,
	args_hash TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_tokens_expires ON approval_tokens(expires_at);
