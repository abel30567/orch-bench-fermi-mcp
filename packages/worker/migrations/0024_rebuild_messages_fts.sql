-- 0002_seed.sql inserts a message before 0003 adds the FTS triggers, so that row was never
-- indexed and deleting or updating it fails with SQLITE_CORRUPT. Rebuild the external-content
-- index from messages so every existing row is indexed. Safe to re-run.
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
