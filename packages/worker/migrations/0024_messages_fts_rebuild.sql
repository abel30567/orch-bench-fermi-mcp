-- 0002_seed.sql inserted a message before 0003 added the FTS sync triggers, so that row never
-- reached messages_fts. Deleting it fired the 'delete' trigger for a row the external-content
-- index never had (SQLITE_CORRUPT). Rebuild the index from the messages table. Idempotent.
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
