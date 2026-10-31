-- Approval tokens move from KV to D1 so that redeeming one is a single atomic DELETE.
-- tool and args_hash bind a token to the call that minted it. expires_at is epoch ms.
CREATE TABLE IF NOT EXISTS approval_tokens (
  token      TEXT PRIMARY KEY,
  tool       TEXT NOT NULL,
  args_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_tokens_expires_at ON approval_tokens(expires_at);
