-- Rebuild the messages FTS index from the messages table.
-- 0002_seed.sql inserted a message before 0003 added the sync triggers, so that row was never
-- indexed; deleting it fired the FTS 'delete' trigger for a missing entry -> SQLITE_CORRUPT.
-- 'rebuild' re-derives the external-content index from messages; safe to re-run.
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
