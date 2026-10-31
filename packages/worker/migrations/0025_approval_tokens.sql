-- Single-use approval tokens for high-risk tools (previously KV `approval:<token>`).
-- Redemption is one DELETE ... RETURNING, so concurrent redeems of one token
-- cannot both succeed. A token is bound to the tool and args hash it was minted
-- for and expires 300 s after minting (expires_at in epoch milliseconds).
CREATE TABLE IF NOT EXISTS approval_tokens (
  token TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_tokens_expires ON approval_tokens(expires_at);
