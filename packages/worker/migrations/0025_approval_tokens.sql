-- Single-use approval tokens for high-risk tools. Redemption is one conditional
-- DELETE, which D1 runs atomically, so concurrent redeems of one token cannot
-- both succeed (KV get-then-delete could). A token is bound to the tool and the
-- hash of the args it was minted for; expires_at is epoch ms, 300 s after minting.
CREATE TABLE IF NOT EXISTS approval_tokens (
  token TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_tokens_expires ON approval_tokens(expires_at);
