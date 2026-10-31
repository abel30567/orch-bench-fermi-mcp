-- 0002_seed.sql inserted a message before 0003 added the FTS sync triggers, so that row was never
-- indexed and deleting it made messages_ad issue an FTS 'delete' for a missing entry (SQLITE_CORRUPT).
-- Rebuild the external-content index from the messages table. Idempotent.
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
