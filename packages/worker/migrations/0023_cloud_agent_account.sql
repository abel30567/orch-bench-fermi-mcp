-- Alternate Claude account per launch: NULL = default account
-- (CLAUDE_CODE_OAUTH_TOKEN); otherwise CLAUDE_CODE_OAUTH_TOKEN_<ACCOUNT>.
ALTER TABLE cloud_agents ADD COLUMN account TEXT;
