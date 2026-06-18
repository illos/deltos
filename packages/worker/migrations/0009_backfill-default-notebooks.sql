-- Notebooks BACKFILL (ui-backbone-notebooks §B, 2026-06-18) — give every EXISTING account its notebook
-- entities so the feature works on current data. SECSYS-GATED (creates per-account rows).
--
-- APPROACH (no note movement, no orphans): create ONE notebooks row per DISTINCT (accountId, notebookId)
-- that already carries notes — so current notes KEEP their notebookId and resolve to a real notebook —
-- and create a fresh default for accounts that have no notes yet. Exactly ONE per account is marked the
-- undeletable DEFAULT (isDefault=1): the account's primary notebookId (the one holding its earliest note
-- by syncSeq). Each new notebook gets a syncSeq ABOVE the account's current max so every device pulls it.
--
-- 🚨 BOLA SAFETY (cross-account-data-layer-finding): strictly intra-account by construction — every
-- INSERT's accountId comes from the source row's own accountId; rows are grouped/partitioned BY accountId
-- and never joined across accounts. The partial unique index `notebooks_oneDefault` (0008) makes a second
-- default per account fail atomically. A LOUD CHECK-table guard (0003 pattern, no CREATE TEMP TABLE)
-- asserts every account ended with exactly one default. (Most accounts are single-notebook → one default;
-- the lone pre-Fix-A split account becomes default 'Notes' + a non-default 'Notes (2)' — no data moved.)

-- ── 1. Scratch: one row per distinct (accountId, notebookId) that has notes. `minSeq` orders default pick.
CREATE TABLE _mig0009_nb (
  accountId  TEXT    NOT NULL,
  notebookId TEXT    NOT NULL,
  minSeq     INTEGER NOT NULL,
  isDefault  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO _mig0009_nb (accountId, notebookId, minSeq)
  SELECT accountId, notebookId, MIN(syncSeq) FROM notes GROUP BY accountId, notebookId;

-- ── 2. Accounts with NO notes → one fresh default (UUID v4 via randomblob; valid for NotebookIdSchema).
INSERT INTO _mig0009_nb (accountId, notebookId, minSeq)
  SELECT a.accountId,
         lower(
           hex(randomblob(4)) || '-' ||
           hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
           substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
           hex(randomblob(6))
         ),
         0
  FROM accounts a
  WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.accountId = a.accountId);

-- ── 3. Mark exactly ONE default per account: the primary notebook (earliest note, tiebreak notebookId).
WITH ranked AS (
  SELECT rowid AS rid, ROW_NUMBER() OVER (PARTITION BY accountId ORDER BY minSeq ASC, notebookId ASC) AS rn
  FROM _mig0009_nb
)
UPDATE _mig0009_nb SET isDefault = 1 WHERE rowid IN (SELECT rid FROM ranked WHERE rn = 1);

-- ── 4. Create the notebook rows. syncSeq = (account's current accountSyncSeq) + per-account rank, so
-- each lands ABOVE what every device has already pulled. Default ranks first (rn=1 → 'Notes').
WITH numbered AS (
  SELECT b.accountId, b.notebookId, b.isDefault,
         ROW_NUMBER() OVER (PARTITION BY b.accountId ORDER BY b.isDefault DESC, b.minSeq ASC, b.notebookId ASC) AS rn,
         COALESCE((SELECT seq FROM accountSyncSeq s WHERE s.accountId = b.accountId), 0) AS oldMax
  FROM _mig0009_nb b
)
INSERT INTO notebooks (id, accountId, name, defaultCollectionView, isDefault, version, createdAt, updatedAt, deletedAt, syncSeq)
  SELECT notebookId, accountId,
         CASE WHEN isDefault = 1 THEN 'Notes' ELSE 'Notes (' || rn || ')' END,
         'list', isDefault, 1,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL,
         oldMax + rn
  FROM numbered;

-- ── 5. Advance each account's counter past the notebooks just created (oldMax + count).
INSERT INTO accountSyncSeq (accountId, seq)
  SELECT accountId,
         COALESCE((SELECT seq FROM accountSyncSeq s WHERE s.accountId = _mig0009_nb.accountId), 0) + COUNT(*)
  FROM _mig0009_nb GROUP BY accountId
  ON CONFLICT(accountId) DO UPDATE SET seq = MAX(seq, excluded.seq);

-- ── GUARD (post): every account ended with exactly one default notebook. #accounts == #default-notebooks
-- (combined with the oneDefault unique index ⇒ exactly one each). ok MUST be 1 or the migration aborts.
CREATE TABLE _mig0009_default_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _mig0009_default_guard (ok)
  SELECT CASE WHEN (SELECT COUNT(*) FROM accounts) = (SELECT COUNT(*) FROM notebooks WHERE isDefault = 1)
              THEN 1 ELSE 0 END;
DROP TABLE _mig0009_default_guard;

DROP TABLE _mig0009_nb;

INSERT INTO meta (key, value) VALUES ('notebooksBackfilled', '1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
