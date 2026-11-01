-- Alternate Claude account per launch: NULL = the default account
-- (CLAUDE_CODE_OAUTH_TOKEN); otherwise the box is served
-- CLAUDE_CODE_OAUTH_TOKEN_<ACCOUNT> under the standard name. claude route only.
ALTER TABLE cloud_agents ADD COLUMN account TEXT;
