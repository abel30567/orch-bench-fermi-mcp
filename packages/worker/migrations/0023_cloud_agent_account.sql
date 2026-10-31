-- Alternate Claude account per launch: the account id selects the
-- CLAUDE_CODE_OAUTH_TOKEN_<ACCOUNT> secret served at /box/inference-auth.
-- NULL = the default account (plain CLAUDE_CODE_OAUTH_TOKEN).
ALTER TABLE cloud_agents ADD COLUMN account TEXT;
