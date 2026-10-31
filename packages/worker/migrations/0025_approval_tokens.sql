-- Single-use approval tokens for high-risk tools. They were KV get-then-delete, so
-- concurrent redeems of one token could both pass. Redemption is now one
-- conditional DELETE ... RETURNING: exactly one caller consumes a token.
-- expires_at: epoch milliseconds, 300 s after minting.
CREATE TABLE IF NOT EXISTS approval_tokens (
  token TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS approval_tokens_expires_at ON approval_tokens(expires_at);
