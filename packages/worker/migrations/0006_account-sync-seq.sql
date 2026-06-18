-- Fix A (P0 sync regression, 2026-06-18) — make the ACCOUNT the sync boundary (Option B, navSys).
--
-- The per-notebook `notebookSyncSeq` counter (0001) keyed the pull stream on a device-local random
-- notebookId, so two devices of one account got disjoint streams and never converged (the P0). The
-- sync stream is now per-ACCOUNT: this counter is keyed on accountId, and every note write bumps it
-- (db/mutate.ts). notebookSyncSeq + notes_pull are left in place (now unused by the live path) — a
-- later cleanup migration may drop them; leaving them is inert.
--
-- STRUCTURAL ONLY: this migration adds a table + an index. It mutates NO note rows and crosses NO
-- account boundary. The legacy-data reconciliation (renumber existing syncSeq onto the per-account
-- sequence + seed this counter) is the SEPARATE, secSys-gated data migration 0007.

-- Per-account monotonic sync counter. PK = accountId (the stable, server-derived, credential-
-- independent data-ownership key from 0003). Bumped in the same atomic D1 batch as each note write,
-- so the counter and the note's syncSeq stay consistent under concurrent requests.
CREATE TABLE accountSyncSeq (
  accountId TEXT NOT NULL PRIMARY KEY,
  seq       INTEGER NOT NULL DEFAULT 0
);

-- The new primary pull access pattern: WHERE accountId = ? AND syncSeq > ? ORDER BY syncSeq ASC.
CREATE INDEX notes_accountPull ON notes (accountId, syncSeq);
