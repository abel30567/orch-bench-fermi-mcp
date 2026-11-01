-- Rebuild messages_fts from its external content table.
-- 0002_seed.sql inserted a messages row before 0003 added the FTS sync triggers, so that row
-- was never indexed; deleting it fired the 'delete' trigger for a row the index never had
-- (SQLITE_CORRUPT). 'rebuild' re-reads every row of `messages`, so the index matches again.
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
