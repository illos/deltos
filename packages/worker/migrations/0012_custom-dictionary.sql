-- Per-user custom dictionary (custom-keyboard spec §5.2, 2026-06-23) — a first-class, account-scoped,
-- SYNCED entity for the spellcheck allow-list words a user adds. It rides the EXISTING per-account sync
-- stream (accountSyncSeq, accountId boundary — Option B), NOT a parallel system: a dictionary write bumps
-- accountSyncSeq and stores the value in dictionaryWords.syncSeq, so dictionary changes pull alongside
-- notes + notebooks on the one cursor (pullSince UNION).
--
-- SET SEMANTICS → conflict-free: the dictionary is a SET of words per account, so there is NO CAS/version
-- (unlike notes/notebooks). Identity is (accountId, word) — the composite PRIMARY KEY. Add = upsert that
-- clears any tombstone (idempotent, multi-device-safe); remove = set deletedAt (a streamed tombstone).
--
-- STRUCTURAL ONLY: adds a table + index, mutates no rows, crosses no account boundary.

CREATE TABLE dictionaryWords (
  accountId TEXT    NOT NULL,            -- owner; server-derived, scopes every op (never client-asserted)
  word      TEXT    NOT NULL,            -- the normalized custom word (the set element; client trims+lowercases)
  createdAt TEXT    NOT NULL,
  updatedAt TEXT    NOT NULL,
  deletedAt TEXT,                        -- tombstone (remove); NULL = live
  syncSeq   INTEGER NOT NULL DEFAULT 0,  -- shared per-account pull-stream position
  PRIMARY KEY (accountId, word)          -- (accountId, word) = the conflict-free identity (set semantics)
);

-- Primary pull access pattern: WHERE accountId = ? AND syncSeq > ? ORDER BY syncSeq.
CREATE INDEX dictionaryWords_accountPull ON dictionaryWords (accountId, syncSeq);
