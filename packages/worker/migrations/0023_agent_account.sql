-- Per-launch Claude account: names the CLAUDE_CODE_OAUTH_TOKEN_<ACCOUNT> secret
-- a box is served. NULL = the default account (CLAUDE_CODE_OAUTH_TOKEN).
ALTER TABLE cloud_agents ADD COLUMN account TEXT;
