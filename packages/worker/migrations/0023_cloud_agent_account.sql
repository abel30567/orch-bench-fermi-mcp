-- Per-launch Claude account: launches may name an alternate account whose
-- token lives in the CLAUDE_CODE_OAUTH_TOKEN_<ACCOUNT> secret. NULL = default.
ALTER TABLE cloud_agents ADD COLUMN account TEXT;
