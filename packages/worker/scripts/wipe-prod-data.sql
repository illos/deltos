-- One-shot DEV data wipe (pre-real-users clean slate). 2026-06-20.
-- Clears ALL user/account data while PRESERVING the schema + migration state, so NO migration re-runs
-- (the idempotency risk of drop-all + re-migrate is avoided entirely).
--
-- SAFE because: the schema declares NO foreign keys (verified across all migrations) → DELETE order is
-- irrelevant. After this, the DB has empty data tables but the full schema; the next fresh /signup seeds
-- its own default notebook inline (createDefaultNotebook), so no backfill (0008/0009) is needed.
--
-- PRESERVED (do NOT delete): d1_migrations (D1's migration tracker), meta (migration sentinels e.g.
-- notebooksBackfilled), and the _migration_*_guard / _mig0009_* guard tables (migration bookkeeping).
-- Touching d1_migrations would re-run migrations on next deploy; touching the guard tables is pointless.
--
-- Run: wrangler d1 execute deltos --remote --file=packages/worker/scripts/wipe-prod-data.sql

DELETE FROM notes;
DELETE FROM notebooks;
DELETE FROM accountSyncSeq;
DELETE FROM grants;
DELETE FROM refreshSessions;
DELETE FROM passwordCredentials;
DELETE FROM accountCredentials;
DELETE FROM usernames;
DELETE FROM authChallenges;
DELETE FROM authThrottle;
DELETE FROM devices;
DELETE FROM accounts;
