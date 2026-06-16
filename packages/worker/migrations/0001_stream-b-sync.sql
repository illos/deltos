-- Stream B: monotonic sync cursor + fork tracking (Phase 1).
--
-- Cursor model (PIN-SYNC-2): per-note `syncSeq` is a monotonically increasing position in the
-- notebook's pull stream. It is set atomically with every note write (see db/mutate.ts). The
-- pull query uses WHERE syncSeq > :cursor so every committed write is visible to subsequent pulls
-- regardless of timestamp collisions. Gaps (from failed CAS attempts that still bumped the
-- counter) are intentional and harmless — pull only requires monotone order, not contiguity.
--
-- Fork tracking (PIN-SYNC-4): `forkedFromId` is set on the *copy* when a conflict or
-- delete-vs-edit resurrection is created. The original note retains its id (inbound relations stay
-- valid); the fork gets a new UUID. NULL on all non-forked notes.

ALTER TABLE notes ADD COLUMN syncSeq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN forkedFromId TEXT;

-- Per-notebook monotonic counter. Bumped in the same D1 batch as the note write so the counter
-- and the note's syncSeq are always consistent under concurrent requests.
--
-- CONSCIOUS V1-ACCEPT (secSys, 2026-06-16): the PRIMARY KEY is notebookId ALONE, not
-- (accountId, notebookId). With per-account row isolation (notes.accountId, migration 0003), two
-- accounts that happen to use the SAME notebookId string share THIS one seq-counter row. Note rows
-- stay fully isolated — pull/search/get all filter on accountId, so there is no leak and no missed
-- write (syncSeq gaps are the documented-harmless case) — but the SEQUENCE SPACE is shared: a weak
-- write-activity side-channel (an account observing gaps could infer that *some* other account
-- writes under the same guessed notebookId string — activity-exists only, never content) plus write
-- contention on one row. ACCEPTED for v1; re-key to (accountId, notebookId) when notebooks become
-- first-class (planSys roadmap). Deferred — not a gate.
CREATE TABLE notebookSyncSeq (
  notebookId TEXT NOT NULL PRIMARY KEY,
  seq        INTEGER NOT NULL DEFAULT 0
);

-- Pull-stream index (primary access pattern for sync).
-- List-view index (note ordering by recency).
-- The Phase-0 notes_byNotebook index covered updatedAt ordering; replace it with two
-- purpose-named indexes so the query planner picks the right one.
DROP INDEX IF EXISTS notes_byNotebook;
CREATE INDEX notes_pull ON notes (notebookId, syncSeq);
CREATE INDEX notes_list ON notes (notebookId, updatedAt);
