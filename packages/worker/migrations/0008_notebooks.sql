-- Notebooks feature (ui-backbone-notebooks.md §B, 2026-06-18) — notebooks as a first-class,
-- account-scoped, SYNCED entity. They ride the EXISTING per-account sync stream (accountSyncSeq,
-- accountId boundary — Option B), NOT a parallel system: a notebook write bumps accountSyncSeq and
-- stores the value in notebooks.syncSeq, so notebook changes pull alongside notes on one cursor.
--
-- STRUCTURAL ONLY: adds a table + indexes, mutates no rows, crosses no account boundary. The backfill
-- (one undeletable default notebook per existing account) is the SEPARATE, secSys-gated data
-- migration 0009.

CREATE TABLE notebooks (
  id                    TEXT    NOT NULL PRIMARY KEY,  -- client-generated UUID (or adopted implicit notebookId)
  accountId             TEXT    NOT NULL,              -- owner; server-derived, scopes every op (never client-asserted)
  name                  TEXT    NOT NULL,
  defaultCollectionView TEXT    NOT NULL DEFAULT 'list',
  isDefault             INTEGER NOT NULL DEFAULT 0,    -- 1 = the single undeletable default per account (system-owned)
  version               INTEGER NOT NULL DEFAULT 1,    -- CAS counter (rename / delete)
  createdAt             TEXT    NOT NULL,
  updatedAt             TEXT    NOT NULL,
  deletedAt             TEXT,                          -- tombstone; NULL = live
  syncSeq               INTEGER NOT NULL DEFAULT 0     -- shared per-account pull-stream position
);

-- Primary pull access pattern: WHERE accountId = ? AND syncSeq > ? ORDER BY syncSeq.
CREATE INDEX notebooks_accountPull ON notebooks (accountId, syncSeq);

-- Enforce EXACTLY ONE default notebook per account at the DB (partial unique index over the live
-- default). A second isDefault=1 row for the same account fails atomically — the default is
-- system-owned and singular.
CREATE UNIQUE INDEX notebooks_oneDefault ON notebooks (accountId) WHERE isDefault = 1;
