-- 0020 — GRANT SETS (ROAD-0011 P1 §1.2): a single agent token may be scoped to several notebooks/notes,
-- stored as N `grants` rows sharing ONE tokenHash and ONE tokenGroupId (the mint event). Two schema changes:
--
--   1. `grants.tokenHash` loses its 0002 UNIQUE constraint — N rows must share one hash so the presented
--      token resolves to the whole set (resolveGrantsByTokenHash). SQLite cannot drop a column constraint
--      in place, so the table is REBUILT (a regular table, NOT a TEMP table — the D1 authorizer rejects
--      CREATE TEMP TABLE, migration-d1-no-temp-table). A new non-unique index preserves resolve-by-hash.
--   2. `grants.tokenGroupId` is added — the shared, non-secret id that groups a set into one logical token
--      (the whole-token revoke + Connected-apps grouping key). NULL on pre-existing single-resource rows
--      (each is then its own token); new agent mints always populate it.
--
-- Also adds `oauthAuthCode.resources` (JSON) so a consent-approved resource SET survives the code→token
-- exchange. LANDMINES honoured: NEW migration number (never rewrite an applied file); no CREATE TEMP TABLE;
-- validate on real D1 (`db:migrate:local`), not only better-sqlite3. Prod DB is disposable (pre-real-users),
-- but the rebuild carries every existing grant forward correctly regardless.

-- ── Step 1 — rebuild `grants` without UNIQUE(tokenHash), with a tokenGroupId column ──────────────────
-- Mirrors the cumulative grants schema after 0002 (+label 0013, +familyId 0014, +clientId 0017), plus the
-- new tokenGroupId. tokenHash is a plain (indexed, non-unique) column now.
CREATE TABLE grants_rebuild (
  grantId       TEXT    NOT NULL PRIMARY KEY,
  tokenHash     TEXT    NOT NULL,                 -- NO LONGER UNIQUE — a grant set shares one hash across N rows.
  tokenGroupId  TEXT,                             -- groups a mint event's rows into one token; NULL = its own token.
  principalKind TEXT    NOT NULL,
  principalId   TEXT    NOT NULL,
  mintedByKeyId TEXT,
  resourceKind  TEXT    NOT NULL,                 -- 'workspace' | 'notebook' | 'note'
  resourceId    TEXT,
  scope         TEXT    NOT NULL,
  expiresAtMs   INTEGER,
  revokedAt     TEXT,
  createdAt     TEXT    NOT NULL,
  label         TEXT,
  familyId      TEXT,
  clientId      TEXT
);

-- Carry every existing row forward; existing single-resource rows get tokenGroupId = grantId (their own
-- group), so the grouped listings surface them unchanged.
INSERT INTO grants_rebuild
  (grantId, tokenHash, tokenGroupId, principalKind, principalId, mintedByKeyId,
   resourceKind, resourceId, scope, expiresAtMs, revokedAt, createdAt, label, familyId, clientId)
  SELECT grantId, tokenHash, grantId, principalKind, principalId, mintedByKeyId,
         resourceKind, resourceId, scope, expiresAtMs, revokedAt, createdAt, label, familyId, clientId
    FROM grants;

DROP TABLE grants;
ALTER TABLE grants_rebuild RENAME TO grants;

-- Recreate the indexes 0002 + 0017 defined, plus the two new ones. grants_byTokenHash REPLACES the dropped
-- UNIQUE index as the resolve-by-hash path (now non-unique); grants_byTokenGroup backs whole-token ops.
CREATE INDEX grants_byMintedKey ON grants (mintedByKeyId);
CREATE INDEX grants_byClientId  ON grants (clientId);
CREATE INDEX grants_byTokenHash ON grants (tokenHash);
CREATE INDEX grants_byTokenGroup ON grants (tokenGroupId);

-- ── Step 2 — carry the consent resource SET through the auth code ────────────────────────────────────
-- JSON Resource[]; NULL on pre-existing codes → the redemption treats absent as the whole workspace.
ALTER TABLE oauthAuthCode ADD COLUMN resources TEXT;
