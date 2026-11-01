-- Approval tokens move from KV to D1 so redemption is one atomic DELETE.
-- expires_at is epoch milliseconds, 300 s after minting.
CREATE TABLE IF NOT EXISTS approval_tokens (
  token TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_tokens_expires_at ON approval_tokens(expires_at);
