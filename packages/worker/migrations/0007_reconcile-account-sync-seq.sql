-- Fix A — MIGRATION (P0 sync regression, 2026-06-18) — reconcile legacy note rows onto the
-- per-ACCOUNT sync stream introduced by 0006. SECSYS-GATED (mutates prod note rows).
--
-- WHY: before Fix A, syncSeq was assigned by the per-notebook counter (0001). An account split across
-- divergent device-local notebookIds therefore has syncSeq values that COLLIDE across its notebooks
-- (notebook X: 1,4,6 ; notebook Y: 1,2,3). The new account-scoped pull (WHERE accountId=? AND
-- syncSeq>? ORDER BY syncSeq) needs syncSeq UNIQUE + MONOTONIC per account, or an incremental cursor
-- could straddle a tie and skip a note (data loss — sync-pushqueued-drain-invariants). This migration
-- renumbers each account's notes onto one clean per-account sequence and seeds accountSyncSeq.
--
-- 🚨 BOLA SAFETY (cross-account-data-layer-finding): every step operates STRICTLY within a single
-- accountId. The renumber PARTITIONs BY accountId — by construction it can NEVER move, merge, or
-- read a note across an account boundary. The two CHECK-table guards below are LOUD fail-closed belts
-- that ABORT THE WHOLE MIGRATION (the CHECK fires on INSERT, rolling back the transaction) on any
-- precondition/postcondition violation. CHECK-table pattern (not CREATE TEMP TABLE — D1's migration
-- authorizer rejects TEMP with SQLITE_AUTH; migration-d1-no-temp-table); same shape as 0003's guard.
--
-- Idempotent-safe seed (ON CONFLICT) and immutable-column ordering (createdAt, id — never the syncSeq
-- being mutated) make the renumber deterministic and re-runnable.

-- ── GUARD 1 (pre): abort if ANY note lacks an accountId. Such a row cannot be placed in a per-account
-- stream (it would be silently invisible forever) and signals an un-scoped note — fail LOUD, never
-- guess an owner (F-acct-5). n MUST be 0.
CREATE TABLE _migration_0007_null_guard (n INTEGER NOT NULL CHECK (n = 0));
INSERT INTO _migration_0007_null_guard (n) SELECT COUNT(*) FROM notes WHERE accountId IS NULL;
DROP TABLE _migration_0007_null_guard;

-- ── RENUMBER: assign each account's notes a fresh 1..N syncSeq, partitioned BY accountId (intra-account
-- only). Order by IMMUTABLE columns (createdAt, then id as a unique tiebreak) so ROW_NUMBER is stable
-- and independent of the syncSeq column being rewritten.
WITH renum AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY accountId ORDER BY createdAt, id) AS rn
  FROM notes
  WHERE accountId IS NOT NULL
)
UPDATE notes
  SET syncSeq = (SELECT rn FROM renum WHERE renum.id = notes.id)
  WHERE accountId IS NOT NULL;

-- ── GUARD 2 (post): assert per-account syncSeq uniqueness — total notes == distinct (accountId,
-- syncSeq) pairs. If any account still has a duplicate syncSeq the renumber is unsound; ok=0 → abort.
CREATE TABLE _migration_0007_unique_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _migration_0007_unique_guard (ok)
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM notes WHERE accountId IS NOT NULL)
    = (SELECT COUNT(*) FROM (SELECT DISTINCT accountId, syncSeq FROM notes WHERE accountId IS NOT NULL))
  THEN 1 ELSE 0 END;
DROP TABLE _migration_0007_unique_guard;

-- ── SEED the per-account counter to each account's new max syncSeq, so the next live write continues
-- monotonically. Accounts with no notes get no row (their first write INSERTs seq=1 via the live
-- BUMP ON CONFLICT). MAX(seq, excluded.seq) never regresses an already-advanced counter (re-run belt).
INSERT INTO accountSyncSeq (accountId, seq)
  SELECT accountId, MAX(syncSeq) FROM notes WHERE accountId IS NOT NULL GROUP BY accountId
  ON CONFLICT(accountId) DO UPDATE SET seq = MAX(seq, excluded.seq);

-- Substrate marker so readiness checks can prove this migration applied.
INSERT INTO meta (key, value) VALUES ('accountSyncSeqReconciled', '1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
