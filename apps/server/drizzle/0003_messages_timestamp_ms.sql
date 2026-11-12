-- Hand-written data migration (2026-09-16, Aegis three-fixes plan Task 2):
-- messages.created_at switched from second-precision to millisecond-precision
-- storage (schema.ts mode "timestamp" -> "timestamp_ms"; no SQL-level change,
-- drizzle-kit reports "No schema changes"). Existing rows stored whole
-- seconds and must be scaled to ms so they do not read back as 1970-01-01.
-- Guard: real second-precision timestamps for this app are ~1.7e9 (< 1e11);
-- real ms-precision timestamps are ~1.7e12 (> 1e11).
UPDATE `messages` SET `created_at` = `created_at` * 1000 WHERE `created_at` < 100000000000;
