-- Alternate Claude account per launch: null = the default account
-- (CLAUDE_CODE_OAUTH_TOKEN); otherwise /box/inference-auth serves
-- CLAUDE_CODE_OAUTH_TOKEN_<ACCOUNT>.
ALTER TABLE cloud_agents ADD COLUMN account TEXT;
