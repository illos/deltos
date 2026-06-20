-- 0010 — "All Notes" synthetic default (#58): notes.notebookId → NULLABLE; retire the stored
-- default-notebook apparatus entirely. Architectural refactor (Jim's directive), not a patch.
--
-- WHY: collapse the undeletable default "Notes" notebook + the all-notes aggregate into ONE synthetic,
-- never-stored "All Notes" view. A note with notebookId = NULL is UNCATEGORIZED (lives only in All Notes).
-- With no stored default row, the duplicate-default bug class (the 2026-06-20 incident root) is
-- STRUCTURALLY impossible — there is nothing to duplicate.
--
-- LANDMINES honoured: NEW migration number (never rewrite an applied one — migration-never-rewrite-applied);
-- NO `CREATE TEMP TABLE` (D1 authorizer rejects it — migration-d1-no-temp-table); validate on real D1
-- (`db:migrate:local`), not only better-sqlite3. The prod DB is freshly wiped, so there is no data to
-- migrate — but the steps are correct as a PATTERN (and defensively handle any residual default rows).

-- ── Step 1 — rebuild `notes` with a NULLABLE notebookId ──────────────────────────────────────────────
-- SQLite cannot ALTER a column's NOT NULL; the canonical fix is a table rebuild (regular table, NOT temp).
-- The new table mirrors the full current schema (0000 + syncSeq/forkedFromId from 0001 + accountId from
-- 0003) with notebookId nullable. The carry-over INSERT also UNCATEGORIZES any note that lived in a
-- default notebook — strictly INTRA-ACCOUNT (the subquery is correlated on notes.accountId; notebookId is
-- a globally-unique id so the match is the same account's notebook anyway) — so retiring defaults never
-- strands a note on a now-deleted default row.
CREATE TABLE notes_new (
  id           TEXT    NOT NULL PRIMARY KEY,
  notebookId   TEXT,                          -- #58: NULLABLE (null = uncategorized → All Notes)
  title        TEXT    NOT NULL DEFAULT '',
  properties   TEXT    NOT NULL DEFAULT '{}',
  body         TEXT    NOT NULL DEFAULT '[]',
  version      INTEGER NOT NULL DEFAULT 0,
  createdAt    TEXT    NOT NULL,
  updatedAt    TEXT    NOT NULL,
  deletedAt    TEXT,
  syncSeq      INTEGER NOT NULL DEFAULT 0,
  forkedFromId TEXT,
  accountId    TEXT
);

INSERT INTO notes_new (id, notebookId, title, properties, body, version, createdAt, updatedAt, deletedAt, syncSeq, forkedFromId, accountId)
  SELECT id,
         CASE
           WHEN notebookId IN (SELECT nb.id FROM notebooks nb WHERE nb.accountId = notes.accountId AND nb.isDefault = 1)
             THEN NULL                         -- note lived in this account's default → uncategorize
           ELSE notebookId
         END,
         title, properties, body, version, createdAt, updatedAt, deletedAt, syncSeq, forkedFromId, accountId
    FROM notes;

DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;

-- Recreate every index exactly as 0000/0001/0003/0006 defined them.
CREATE INDEX notes_byNotebook  ON notes (notebookId, updatedAt);
CREATE INDEX notes_pull        ON notes (notebookId, syncSeq);
CREATE INDEX notes_list        ON notes (notebookId, updatedAt);
CREATE INDEX notes_byAccount   ON notes (accountId, notebookId);
CREATE INDEX notes_accountPull ON notes (accountId, syncSeq);

-- ── Step 2 — retire the stored default-notebook apparatus ────────────────────────────────────────────
-- Drop every default notebook ROW (their notes were just uncategorized above). Real notebooks are
-- untouched — only the system-owned default container is removed.
DELETE FROM notebooks WHERE isDefault = 1;

-- Drop the one-default partial unique index (0008). With no default, there is nothing to enforce — and
-- removing it is what makes a second default STRUCTURALLY impossible-by-absence rather than index-rejected.
DROP INDEX IF EXISTS notebooks_oneDefault;
