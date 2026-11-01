-- Approval tokens for high-risk tools (pr-53). Moved from KV to D1 so redemption
-- is one atomic DELETE ... RETURNING: concurrent redeems of a token cannot both
-- succeed. expires_at is epoch milliseconds, 300 s after minting (the old KV TTL).
CREATE TABLE IF NOT EXISTS approval_tokens (
  token TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_tokens_expires_at ON approval_tokens(expires_at);
