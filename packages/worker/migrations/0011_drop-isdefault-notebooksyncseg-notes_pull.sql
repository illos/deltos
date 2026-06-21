-- 0011 — schema cleanup (#61 + #13): drop vestigial columns/table/index.
--
-- #61 (isDefault): the `isDefault` column is always 0/false post-All-Notes (#58). The stored-default
--   apparatus was retired in 0010 (all default rows deleted, notebooks_oneDefault index dropped). The
--   column itself is now vestigial — nothing reads or writes it. Drop it from the notebooks table via
--   the canonical table-rebuild pattern (SQLite cannot ALTER DROP COLUMN on older engine builds;
--   this mirrors exactly what 0010 did for notes.notebookId).
--
-- #13 (notebookSyncSeq + notes_pull): dead since Option-B (0006/account-sync-seq). notebookSyncSeq
--   was a per-notebook pull cursor (one row per device×notebook); notes_pull indexed (notebookId,syncSeq).
--   Both are superseded by per-ACCOUNT sync (accountSyncSeq + notes_accountPull). No live code path
--   reads either. Drop them.
--
-- LANDMINES honoured: NEW migration number; NO temp tables; validate with db:migrate:local before deploy
-- (migration-d1-no-temp-table / migration-never-rewrite-applied).
-- Prod DB was wiped post-0010 deploy, so there is no data to carry through the rebuild — but the
-- INSERT/SELECT pattern is correct as a pattern and handles any residual notebook rows.

-- ── #61 — rebuild notebooks WITHOUT isDefault ─────────────────────────────────────────────────────────
-- SQLite cannot DROP COLUMN reliably on all engine builds; canonical fix = table rebuild.
-- New schema is identical to 0008 minus the `isDefault` column (+ the notebooks_oneDefault index,
-- already dropped in 0010).
CREATE TABLE notebooks_new (
  id                    TEXT    NOT NULL PRIMARY KEY,
  accountId             TEXT    NOT NULL,
  name                  TEXT    NOT NULL,
  defaultCollectionView TEXT    NOT NULL DEFAULT 'list',
  version               INTEGER NOT NULL DEFAULT 1,
  createdAt             TEXT    NOT NULL,
  updatedAt             TEXT    NOT NULL,
  deletedAt             TEXT,
  syncSeq               INTEGER NOT NULL DEFAULT 0
);

INSERT INTO notebooks_new (id, accountId, name, defaultCollectionView, version, createdAt, updatedAt, deletedAt, syncSeq)
  SELECT id, accountId, name, defaultCollectionView, version, createdAt, updatedAt, deletedAt, syncSeq
    FROM notebooks;

DROP TABLE notebooks;
ALTER TABLE notebooks_new RENAME TO notebooks;

-- Recreate the index from 0008 (notebooks_oneDefault was already dropped in 0010).
CREATE INDEX notebooks_accountPull ON notebooks (accountId, syncSeq);

-- ── #13 — drop notebookSyncSeq table (dead since 0006/Option-B) ──────────────────────────────────────
DROP TABLE IF EXISTS notebookSyncSeq;

-- ── #13 — drop notes_pull index (dead since 0006/Option-B; recreated in 0010 but still unused) ───────
-- The live pull index is notes_accountPull ON notes (accountId, syncSeq).
DROP INDEX IF EXISTS notes_pull;
