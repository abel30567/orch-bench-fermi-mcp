-- 0002_seed.sql inserted a message before 0003 added the FTS sync triggers, so that row was
-- never indexed in messages_fts. Deleting it then fires messages_ad for a row the
-- external-content index never had, which corrupts it (SQLITE_CORRUPT). Rebuild the index
-- from the messages table so every existing row is indexed.
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
