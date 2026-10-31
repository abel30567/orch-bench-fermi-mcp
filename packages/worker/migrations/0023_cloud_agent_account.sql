-- Alternate Claude account per launch: a claude-route agent may name an
-- account id whose OAuth token lives in CLAUDE_CODE_OAUTH_TOKEN_<ACCOUNT>.
-- NULL = the default account (CLAUDE_CODE_OAUTH_TOKEN).
ALTER TABLE cloud_agents ADD COLUMN account TEXT;
