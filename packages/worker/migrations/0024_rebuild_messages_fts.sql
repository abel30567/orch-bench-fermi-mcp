-- 0002_seed.sql inserts a message before 0003 adds the FTS triggers, so that row
-- never reached messages_fts and the delete trigger fails on it with SQLITE_CORRUPT.
-- Rebuild the external-content index from messages so every row is indexed.
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
