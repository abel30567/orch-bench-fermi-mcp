-- Per-launch Claude account: cloud agents on the claude route may run under an
-- alternate account whose token lives in CLAUDE_CODE_OAUTH_TOKEN_<ACCOUNT>.
-- NULL = the default account (CLAUDE_CODE_OAUTH_TOKEN).
ALTER TABLE cloud_agents ADD COLUMN account TEXT;
