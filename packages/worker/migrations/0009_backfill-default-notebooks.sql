-- Notebooks BACKFILL — CONSOLIDATE (ui-backbone-notebooks §B; navSys/user decision 2026-06-18, task #26).
-- SECSYS-GATED (creates per-account rows + re-stamps notes). Every existing account ends with EXACTLY
-- ONE clean default notebook named 'Notes' — NO 'Notes (2)', no debris notebooks. (User: no real data,
-- consolidate; full latitude for the simplest clean path.)
--
-- APPROACH: per account, pick a CANONICAL notebookId = the notebookId of its earliest note (by syncSeq),
-- or a fresh UUIDv4 if the account has no notes. Create ONE default notebook with that id, and RE-STAMP
-- every note whose notebookId differs onto it — so the account collapses to a single notebook and no note
-- is orphaned. Re-stamped notes get a fresh syncSeq ABOVE the account's current max so every device pulls
-- the consolidation; the default notebook also lands above the max. Notes already on the canonical id keep
-- their syncSeq untouched.
--
-- 🚨 BOLA SAFETY (cross-account-data-layer-finding): strictly intra-account by construction — canonical,
-- re-stamp, and counter are all keyed/partitioned BY accountId; nothing is joined or moved across accounts.
-- The partial unique index `notebooks_oneDefault` (0008) blocks a second default. Three LOUD CHECK-table
-- guards (0003 pattern, NO CREATE TEMP TABLE) abort the whole migration on any violation:
--   (1) any NULL-accountId note (unscoped → can't place);
--   (2) #accounts != #default-notebooks (some account missing its one default);
--   (3) any note NOT pointing at its account's default (consolidation incomplete / debris reference).

-- ── GUARD 1 (pre): no unscoped note.
CREATE TABLE _mig0009_null_guard (n INTEGER NOT NULL CHECK (n = 0));
INSERT INTO _mig0009_null_guard (n) SELECT COUNT(*) FROM notes WHERE accountId IS NULL;
DROP TABLE _mig0009_null_guard;

-- ── 1. Per-account plan: canonical notebookId + the account's current syncSeq max (oldMax).
CREATE TABLE _mig0009_acct (
  accountId    TEXT PRIMARY KEY,
  canonical    TEXT,
  oldMax       INTEGER NOT NULL,
  changedCount INTEGER NOT NULL DEFAULT 0
);
INSERT INTO _mig0009_acct (accountId, canonical, oldMax)
  SELECT a.accountId,
         (SELECT n.notebookId FROM notes n WHERE n.accountId = a.accountId ORDER BY n.syncSeq ASC, n.id ASC LIMIT 1),
         COALESCE((SELECT seq FROM accountSyncSeq s WHERE s.accountId = a.accountId), 0)
  FROM accounts a;

-- note-less accounts → a fresh UUIDv4 canonical (valid for NotebookIdSchema).
UPDATE _mig0009_acct
  SET canonical = lower(
        hex(randomblob(4)) || '-' ||
        hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
        substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
        hex(randomblob(6))
      )
  WHERE canonical IS NULL;

-- how many notes will be re-stamped per account (notebookId differs from canonical).
UPDATE _mig0009_acct
  SET changedCount = (SELECT COUNT(*) FROM notes n WHERE n.accountId = _mig0009_acct.accountId AND n.notebookId <> _mig0009_acct.canonical);

-- ── 2. Create the ONE default notebook per account (id = canonical), at syncSeq = oldMax + 1.
INSERT INTO notebooks (id, accountId, name, defaultCollectionView, isDefault, version, createdAt, updatedAt, deletedAt, syncSeq)
  SELECT canonical, accountId, 'Notes', 'list', 1, 1,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL,
         oldMax + 1
  FROM _mig0009_acct;

-- ── 3. Re-stamp every note whose notebookId differs onto the canonical, with a fresh per-account syncSeq
-- (oldMax + 1 + rank) so devices pull the consolidation. ROW_NUMBER orders by IMMUTABLE columns
-- (createdAt, id) — never the syncSeq being rewritten. Notes already on canonical are untouched.
WITH changed AS (
  SELECT n.id,
         ROW_NUMBER() OVER (PARTITION BY n.accountId ORDER BY n.createdAt, n.id) AS rn
  FROM notes n JOIN _mig0009_acct a ON a.accountId = n.accountId
  WHERE n.notebookId <> a.canonical
)
UPDATE notes
  SET notebookId = (SELECT canonical FROM _mig0009_acct WHERE accountId = notes.accountId),
      syncSeq    = ((SELECT oldMax FROM _mig0009_acct WHERE accountId = notes.accountId) + 1 + (SELECT rn FROM changed WHERE changed.id = notes.id))
  WHERE id IN (SELECT id FROM changed);

-- ── 4. Advance each account's counter past the notebook + re-stamped notes (oldMax + 1 + changedCount).
INSERT INTO accountSyncSeq (accountId, seq)
  SELECT accountId, oldMax + 1 + changedCount FROM _mig0009_acct WHERE 1
  ON CONFLICT(accountId) DO UPDATE SET seq = MAX(seq, excluded.seq);

-- ── GUARD 2 (post): every account ended with exactly one default.
CREATE TABLE _mig0009_default_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _mig0009_default_guard (ok)
  SELECT CASE WHEN (SELECT COUNT(*) FROM accounts) = (SELECT COUNT(*) FROM notebooks WHERE isDefault = 1)
              THEN 1 ELSE 0 END;
DROP TABLE _mig0009_default_guard;

-- ── GUARD 3 (post): consolidation complete — every note points at its account's DEFAULT (no debris ref).
CREATE TABLE _mig0009_consolidate_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _mig0009_consolidate_guard (ok)
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM notes n
    WHERE n.accountId IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM notebooks nb WHERE nb.id = n.notebookId AND nb.accountId = n.accountId AND nb.isDefault = 1)
  ) THEN 1 ELSE 0 END;
DROP TABLE _mig0009_consolidate_guard;

DROP TABLE _mig0009_acct;

INSERT INTO meta (key, value) VALUES ('notebooksBackfilled', '2')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
