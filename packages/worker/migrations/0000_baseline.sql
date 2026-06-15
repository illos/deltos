-- deltos D1 baseline (Phase 0).
--
-- This is the substrate seam, not feature logic: no handler reads or writes `notes` yet
-- (every API op is a Phase-0 stub). It exists so the shapes Phase 1 depends on are locked now.
--
-- Casing: columns are camelCase, matching the spine 1:1 (notebookId, createdAt, …). deltos
-- carries ONE casing end to end — there is deliberately no camel<->snake mapping layer at the
-- DB edge (that mapping was a known source of silent bugs and is not reproduced here).
--
-- Concurrency: `version` is the fork-on-conflict counter. The sync flush MUST be a single
-- atomic compare-and-swap, never SELECT-then-write:
--
--     UPDATE notes SET ..., version = version + 1, updatedAt = ?
--      WHERE id = ? AND notebookId = ? AND version = :baseVersion;
--
-- then branch on rows-affected: 1 = applied cleanly; 0 = the row moved under us, so the
-- caller forks to a copy. (id, notebookId, version) is the locked CAS triple. Doing this as
-- SELECT-then-UPSERT opens a TOCTOU race that silently loses writes and never forks.

CREATE TABLE notes (
  id          TEXT    NOT NULL PRIMARY KEY,  -- client-generated UUID, stable from creation
  notebookId  TEXT    NOT NULL,
  title       TEXT    NOT NULL DEFAULT '',
  properties  TEXT    NOT NULL DEFAULT '{}', -- JSON-encoded PropertyBag
  body        TEXT    NOT NULL DEFAULT '[]', -- JSON-encoded Block[]
  version     INTEGER NOT NULL DEFAULT 0,    -- fork-on-conflict counter; CAS guard on flush
  createdAt   TEXT    NOT NULL,              -- ISO-8601
  updatedAt   TEXT    NOT NULL,              -- ISO-8601
  deletedAt   TEXT                           -- ISO-8601; soft-delete tombstone, NULL = live
);

-- Notebook is the unit of sync; pulls scope by notebook and order by recency.
CREATE INDEX notes_byNotebook ON notes (notebookId, updatedAt);

-- Substrate metadata (non-domain). Lets readiness checks prove migrations actually applied.
CREATE TABLE meta (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('spineContractVersion', '0');
