-- Alternate Claude account per launch: names the CLAUDE_CODE_OAUTH_TOKEN_<ACCOUNT>
-- secret the box is served. NULL = the default CLAUDE_CODE_OAUTH_TOKEN.
ALTER TABLE cloud_agents ADD COLUMN account TEXT;
