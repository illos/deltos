-- Collections feature (docs/design/collections.md §3) — collections + collectionMembers as
-- first-class, account-scoped, SYNCED entities. They ride the EXISTING per-account sync stream
-- (accountSyncSeq, accountId boundary — Option B), NOT a parallel system: a collection/member
-- write bumps accountSyncSeq and stores the value in the row's syncSeq, so changes pull alongside
-- notes + notebooks on one cursor.
--
-- STRUCTURAL ONLY: adds two tables + indexes, mutates no rows, crosses no account boundary.
-- Model C join entity (collectionMembers) so concurrent membership edits never contend on a
-- shared collection/note CAS version. See collections.md §2.

CREATE TABLE collections (
  id         TEXT    NOT NULL PRIMARY KEY,  -- client-generated UUID
  accountId  TEXT    NOT NULL,              -- owner; server-derived, scopes every op
  notebookId TEXT,                          -- HOME notebook (v1 always set; NULL reserved for v2 global)
  name       TEXT    NOT NULL,
  icon       TEXT,
  color      TEXT,
  ord        REAL    NOT NULL DEFAULT 0,    -- accordion order within the home notebook
  rule       TEXT,                          -- JSON, NULL in v1 (opaque reserved seam)
  version    INTEGER NOT NULL DEFAULT 1,    -- CAS counter (rename / restyle / reorder / delete)
  createdAt  TEXT    NOT NULL,
  updatedAt  TEXT    NOT NULL,
  deletedAt  TEXT,                          -- tombstone; NULL = live
  syncSeq    INTEGER NOT NULL DEFAULT 0     -- shared per-account pull-stream position
);

-- Primary pull access pattern: WHERE accountId = ? AND syncSeq > ? ORDER BY syncSeq.
CREATE INDEX collections_accountPull ON collections (accountId, syncSeq);

-- List live collections in a home notebook (accordion zone).
CREATE INDEX collections_byNotebook ON collections (accountId, notebookId, deletedAt);

CREATE TABLE collectionMembers (
  id           TEXT    NOT NULL PRIMARY KEY,  -- client-generated UUID
  accountId    TEXT    NOT NULL,              -- owner; server-derived
  collectionId TEXT    NOT NULL,
  noteId       TEXT    NOT NULL,
  ord          REAL    NOT NULL DEFAULT 0,    -- fractional order within the collection
  version      INTEGER NOT NULL DEFAULT 1,    -- CAS counter (reorder / tombstone)
  createdAt    TEXT    NOT NULL,
  updatedAt    TEXT    NOT NULL,
  deletedAt    TEXT,                          -- tombstone; NULL = live member
  syncSeq      INTEGER NOT NULL DEFAULT 0     -- shared per-account pull-stream position
);

-- Idempotent add: re-add of a tombstoned (account, collection, note) revives the row, never a 2nd.
CREATE UNIQUE INDEX collectionMembers_unique ON collectionMembers (accountId, collectionId, noteId);

CREATE INDEX collectionMembers_accountPull ON collectionMembers (accountId, syncSeq);
CREATE INDEX collectionMembers_byCollection ON collectionMembers (accountId, collectionId, deletedAt);
CREATE INDEX collectionMembers_byNote ON collectionMembers (accountId, noteId, deletedAt);
