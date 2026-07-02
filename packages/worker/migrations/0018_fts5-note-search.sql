-- 0018 — server-side full-text search over notes (title + body) via SQLite FTS5.
--
-- ENGINE CHOICE — STANDALONE (regular) FTS5, not external-content and not contentless.
--   A standalone FTS5 table stores its own copy of the indexed text. We deliberately do NOT use an
--   external-content (`content='notes'`) or contentless (`content=''`) table: those bind the FTS index
--   to the exact SQLite build (rowid alignment / `content_rowid`), and the better-sqlite3 used by the
--   test harness can be a different SQLite version from D1's — a mismatch that only surfaces at runtime.
--   A plain standalone table is portable across both. The cost (a duplicated copy of the text) is
--   irrelevant at this scale and buys us harness/prod parity.
--
-- ISOLATION IS NOT IN THE INDEX. There is intentionally NO accountId/notebookId/deletedAt/trash column
--   participating in the MATCH. `notesFts` is a pure text index keyed by `noteId` (UNINDEXED — stored,
--   not tokenized, so it round-trips but never matches as a search term). Every query JOINS back to
--   `notes` and applies `accountId = ?` (server-derived) + `deletedAt IS NULL` + the trash filter there.
--   `notes` is the single BOLA / liveness / trash authority; the FTS table is only a candidate-id source.
--
-- MAINTENANCE IS IN APP CODE, NOT SQL TRIGGERS. Insert/update/patch/delete keep `notesFts` current via
--   db/searchIndex.ts (upsertNoteFts / deleteNoteFts), each run AFTER the note CAS succeeds (a CAS miss
--   must never touch the index). This is eventual-consistent by design: the query re-derives account /
--   liveness / trash from `notes` on every read, so a momentarily-stale FTS row can never leak or
--   mis-scope a result — at worst a just-written note is briefly unfindable by body text. We do NOT use
--   FTS5 external-content triggers precisely because the standalone table + app-code maintenance keeps
--   the write path explicit and harness-portable.
--
-- SEED. Existing live, non-trashed notes are seeded TITLE-ONLY below. Body text lives as a JSON-encoded
--   Block[] in `notes.body` and CANNOT be walked to plaintext in pure SQL — so body is backfilled LAZILY
--   the first time each note is edited (upsertNoteFts re-derives title+body from the read-back row). This
--   is the agreed pragmatic backfill (pre-real-users, data disposable — no standalone backfill script).
--
-- AUTHORIZER SAFETY. This uses CREATE VIRTUAL TABLE and a plain INSERT..SELECT — both allowed by D1's
--   migration authorizer. It does NOT use CREATE TEMP TABLE (SQLITE_AUTH-rejected by D1; see migration
--   0003's note) — the seed is a single set-based INSERT..SELECT with no temp staging.

CREATE VIRTUAL TABLE notesFts USING fts5(
  title,
  body,
  noteId UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Title-only seed for existing live, non-trashed notes. Body fills in lazily on first edit (above).
INSERT INTO notesFts (title, body, noteId)
SELECT title, '', id
FROM notes
WHERE deletedAt IS NULL
  AND json_extract(properties, '$."sys:trashedAt"') IS NULL;
