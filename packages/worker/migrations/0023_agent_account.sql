-- Alternate Claude account per launch: a claude-route cloud agent may name an
-- account id; /box/inference-auth then serves CLAUDE_CODE_OAUTH_TOKEN_<ACCOUNT>
-- under the standard name. NULL = the default account.
ALTER TABLE cloud_agents ADD COLUMN account TEXT;
