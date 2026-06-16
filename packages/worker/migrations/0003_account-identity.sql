-- Stream D / D6 — account-identity dimension (account-vs-credential separation).
--
-- Design: docs/design/account-identity-strawman.md (devSys, signed off by planSys) +
-- docs/design/secSys-cross-account-sweep.md S1–S7. Mechanic = the ZERO-DELTA RE-POINT (planSys):
-- ownership keys on a stable, random, credential-INDEPENDENT `accountId`, NOT on `accountFingerprint`
-- (= SHA-256(signingPublicKey), credential-derived). So changing the auth method never migrates note data.
--
-- ⚠ LOAD-BEARING SEMANTIC (planSys binding condition + LOUD note): after this migration,
--   grants.principalId for OWNER grants MEANS accountId, NOT accountFingerprint.
--   The credential id lives on devices.accountFingerprint and grants.mintedByKeyId — read it THERE,
--   never off a re-pointed principalId. (resolvePrincipal surfaces principalId as principal.id = accountId.)
--
-- F-acct-1 (planSys): ADDITIVE only — accountFingerprint is KEPT as the credential id (F2 binding +
-- per-device revoke + device listing all still key on it via devices / mintedByKeyId / accountCredentials).
-- We ADD accounts + accountCredentials + usernames + notes.accountId, and RE-POINT existing owner grants.
-- No new grants column (principalId itself re-points).

-- accounts — the stable, random, credential-INDEPENDENT identity. accountId is THE data-ownership key.
CREATE TABLE accounts (
  accountId TEXT NOT NULL PRIMARY KEY,  -- random >=16B (hex(randomblob(16))); IMMUTABLE; never client-supplied (secSys S4)
  createdAt TEXT NOT NULL               -- ISO-8601 Z, audit-only
);

-- accountCredentials — the credential -> account map. N:1 (many credentials map to ONE account: the
-- per-device-key future; v1 = one account-level fingerprint). PK on accountFingerprint = BIND-ONCE
-- (a credential binds to exactly one account; re-pointing it to a different account is forbidden —
-- a duplicate INSERT throws). Binding to an EXISTING account requires account-possession proof at the
-- APP layer (secSys S2/S3) — this table only records the (proven) binding.
CREATE TABLE accountCredentials (
  accountFingerprint TEXT NOT NULL PRIMARY KEY,  -- the credential id (base64url SHA-256(signingPublicKey), F2)
  accountId          TEXT NOT NULL,              -- -> accounts.accountId
  credentialType     TEXT NOT NULL,              -- v1: 'signing-key-v1'
  addedAt            TEXT NOT NULL,              -- ISO-8601 Z
  revokedAt          TEXT                        -- ISO-8601 Z; presence = revoked. Replace = add-then-revoke.
);
CREATE INDEX accountCredentials_byAccount ON accountCredentials (accountId);

-- usernames — the DIRECTORY layer: a unique human alias -> account. PK on the normalized form is the
-- atomic-unique claim (INSERT-or-fail, NO check-then-insert TOCTOU — secSys S1). The display form keeps
-- the user's casing; uniqueness is decided on usernameNormalized (NFC + casefold, app layer).
-- INVARIANT (secSys framing): authz/ownership NEVER key on the username — only on accountId. A released
-- + re-claimed username inherits nothing, because everything resolves via accountId.
CREATE TABLE usernames (
  usernameNormalized TEXT NOT NULL PRIMARY KEY,  -- NFC + casefold; THE uniqueness key
  accountId          TEXT NOT NULL,              -- -> accounts.accountId
  usernameDisplay    TEXT NOT NULL,              -- as-typed (within charset)
  createdAt          TEXT NOT NULL
);
CREATE INDEX usernames_byAccount ON usernames (accountId);

-- notes gain the account dimension — the column the per-query scope helper (the PRIMARY fail-closed
-- control) filters on. Nullable to permit ALTER; back-filled below and stamped server-side on every
-- write (never a body field).
ALTER TABLE notes ADD COLUMN accountId TEXT;
CREATE INDEX notes_byAccount ON notes (accountId, notebookId);

-- ============================================================================
-- S5 MIGRATION SAFETY (secSys + planSys) — atomic 1:1 fingerprint->accountId re-point + back-fill,
-- in THIS migration, deployed together with the accountId-aware resolvePrincipal (no wrong-account window).
--
-- GUARD (planSys binding): assert <=1 distinct account in existing data; FAIL LOUD otherwise — never
-- silently back-fill an ambiguous owner. The temp-table CHECK aborts the WHOLE migration if violated.
-- (Pre-deploy reality is empty / single dev account; >1 means RESET dev data or assign owners by hand.)
-- ============================================================================
CREATE TEMP TABLE _migration_0003_guard (n INTEGER NOT NULL CHECK (n <= 1));
INSERT INTO _migration_0003_guard (n)
  SELECT COUNT(DISTINCT accountFingerprint) FROM devices;
DROP TABLE _migration_0003_guard;

-- Seed the single account from the one existing credential fingerprint (dev, pre-multi-account).
-- No-op on a fresh DB (no devices): INSERT...SELECT inserts zero rows.
INSERT INTO accounts (accountId, createdAt)
  SELECT lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE EXISTS (SELECT 1 FROM devices);

-- Bind the existing credential(s) to that account (<=1 distinct fingerprint by the guard).
INSERT INTO accountCredentials (accountFingerprint, accountId, credentialType, addedAt, revokedAt)
  SELECT DISTINCT d.accountFingerprint,
         (SELECT accountId FROM accounts LIMIT 1),
         'signing-key-v1',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         NULL
  FROM devices d;

-- Back-fill existing notes to the single account. If notes exist but NO account was created (no
-- devices) they remain NULL — the ambiguous case (F-acct-5): RESET dev data, do not guess an owner.
UPDATE notes
  SET accountId = (SELECT accountId FROM accounts LIMIT 1)
  WHERE accountId IS NULL AND EXISTS (SELECT 1 FROM accounts);

-- Re-point OWNER grants: principalId fingerprint -> accountId. Credential tracking stays on
-- mintedByKeyId (untouched), so per-device revoke + F2 are preserved. Capability grants
-- (principalKind != 'owner') keep their principalId (a capability id, not a fingerprint).
UPDATE grants
  SET principalId = (SELECT accountId FROM accountCredentials WHERE accountFingerprint = grants.principalId)
  WHERE principalKind = 'owner'
    AND principalId IN (SELECT accountFingerprint FROM accountCredentials);

-- Substrate marker so readiness checks can prove this migration applied.
INSERT INTO meta (key, value) VALUES ('accountIdentitySchemaVersion', '1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
