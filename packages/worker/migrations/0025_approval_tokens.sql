-- Single-use approval tokens for high-risk tools (pr-53). Moved from KV, whose
-- get-then-delete let concurrent redeems of one token both pass. Redemption is
-- one DELETE ... RETURNING, which D1 runs atomically. expires_at is epoch ms,
-- 300 s after minting (the old KV expirationTtl).
CREATE TABLE IF NOT EXISTS approval_tokens (
  token TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_tokens_expires_at ON approval_tokens (expires_at);
