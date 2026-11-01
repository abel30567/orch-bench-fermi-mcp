-- Alternate Claude account per launch (pr-16): NULL = the default account
-- (CLAUDE_CODE_OAUTH_TOKEN); otherwise /box/inference-auth serves
-- CLAUDE_CODE_OAUTH_TOKEN_<ACCOUNT> under the standard name.
ALTER TABLE cloud_agents ADD COLUMN account TEXT;
