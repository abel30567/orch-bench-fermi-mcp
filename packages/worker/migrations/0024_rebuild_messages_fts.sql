-- 0002_seed.sql inserted a message before 0003 added the FTS sync triggers, so that row was never
-- indexed. Deleting it fires messages_ad for a row the external-content index never had, which
-- corrupts messages_fts (SQLITE_CORRUPT). Rebuild the index from the messages table.
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
