-- Stream A (Identity) auth tables: device registry, single-use challenges, opaque grant registry.
--
-- Built to the locked authStore contract (docs/design/stream-a-auth-contracts.md §1, committed by
-- devSys at e3ebd75). Shapes, types, nullability, and security semantics are 1:1 with that contract.
--
-- CASING (deliberate divergence from the contract's illustrative SQL): the contract writes its DDL
-- in snake_case, but deltos carries ONE casing end to end — columns AND tables are camelCase, matching
-- the spine 1:1 (notes.notebookId/createdAt, notebookSyncSeq). 0000_baseline.sql is explicit that
-- there is "deliberately no camel<->snake mapping layer at the DB edge (a known source of silent
-- bugs)". The contract's own authStore function signatures are ALREADY camelCase (challengeId,
-- expiresAtMs, keyId, signingPublicKey), so camelCase columns are the ZERO-mapping fit; snake_case
-- here would force exactly the mapping the baseline forbids. Snake->camel map applied:
--   challenge_id→challengeId, signing_public_key→signingPublicKey, account_fingerprint→accountFingerprint,
--   device_label→deviceLabel, key_id→keyId, expires_at_ms→expiresAtMs, token_hash→tokenHash,
--   principal_kind→principalKind, principal_id→principalId, resource_kind→resourceKind,
--   resource_id→resourceId, issued_at→issuedAt, created_at→createdAt, revoked_at→revokedAt,
--   table auth_challenges→authChallenges. Nothing else changed.
--
-- TIMESTAMPS: comparison-critical `expiresAtMs` is epoch-MILLIS INTEGER so the freshness gate is an
-- instant-correct integer `>` — never a lexical ISO compare (the AUTH-1 storage-layer freshness bug;
-- secSys directive, mirrors Stream B's monotonic-INT choice over timestamps). Audit-only `issuedAt`/
-- `createdAt`/`revokedAt` stay ISO-8601-Z TEXT (never compared with inequality).
--
-- Binary fields (nonce, signingPublicKey, tokenHash) are base64url TEXT — one canonical repr across
-- wire + storage (encoding.ts is the single codec; accountFingerprint is a base64url string compared
-- byte-for-byte per F2). Volumes are tiny, so BLOB's ~33% saving isn't worth the repr split (ruling 1).
--
-- PER-DEVICE-KEY SEAM (D5, planSys): `devices.deviceSigningPublicKey` is carried from day one and ALWAYS
-- populated (NOT NULL): v1 stores the account `signingPublicKey` (strawman F1), Phase-2 per-device-lockout
-- stores each device's OWN key — a non-breaking drop-in. NOT NULL encodes the true integrity invariant
-- (every device row has a signing key); there is no legitimate null state since both v1 and Phase-2 always
-- populate it. It cannot be collapsed into `signingPublicKey`: `accountFingerprint` must stay =
-- SHA-256(signingPublicKey) shared across an account's devices (PIN-ID-3), so the per-device key needs its own column.
--
-- DEFENSE-IN-DEPTH (secSys finding 4): CHECK constraints reject an out-of-set `purpose` or a `consumed`
-- value outside {0,1} at the DB boundary, independent of the application layer.
--
-- REVOCATION (PIN-ID-5, contract ruling 2): `grants.mintedByKeyId` records the device handle that
-- minted each grant (NULL for capability grants). revokeByKeyId(keyId) revokes the device row
-- (devices.revokedAt — blocks future session mints via getDevice's revoked-check) AND that device's
-- outstanding grant rows (grants.revokedAt WHERE mintedByKeyId = keyId — immediate deny on the next
-- request bearing those tokens). The principal stays owner/accountFingerprint, so account-level authz
-- and F2 cross-account binding are untouched; the F1 honest-limitation holds (a mnemonic holder can
-- re-enroll under a NEW keyId and re-mint — registry-handle revoke, not cryptographic lockout).

-- devices (DeviceRegistry). v1 = account-level signing key (F1 option a): every device of an account
-- shares signingPublicKey + accountFingerprint; keyId is the per-device handle used for revocation.
CREATE TABLE devices (
  keyId                  TEXT NOT NULL PRIMARY KEY,  -- server-ASSIGNED random handle (>=16B base64url)
  signingPublicKey       TEXT NOT NULL,              -- ACCOUNT-level Ed25519 pubkey, base64url 32B (v1: shared across the account's devices)
  deviceSigningPublicKey TEXT NOT NULL,              -- option-(b)/D5 per-device-key SEAM, ALWAYS populated. v1 stores the
                                                     -- account signingPublicKey here (strawman F1); Phase-2 per-device-lockout
                                                     -- stores each device's OWN key — a non-breaking drop-in (column exists).
                                                     -- NOT NULL encodes the integrity invariant that every device row has a
                                                     -- signing key (both v1 and Phase-2 always populate it — no null state).
                                                     -- Can't collapse into signingPublicKey: accountFingerprint must stay =
                                                     -- SHA-256(signingPublicKey) shared across devices (PIN-ID-3).
  accountFingerprint     TEXT NOT NULL,              -- base64url(SHA-256(signingPublicKey)) — server-COMPUTED (F2), = Identity.id
  deviceLabel            TEXT NOT NULL,
  createdAt              TEXT NOT NULL,              -- ISO-8601 Z, audit-only
  revokedAt              TEXT                        -- ISO-8601 Z, audit-only; IS NOT NULL = revoked (PIN-ID-5)
);

-- List a device's siblings for the device-management route; revocation resolves by keyId (the PK).
CREATE INDEX devices_byAccount ON devices (accountFingerprint);

-- authChallenges. Short-TTL, single-use. `nonce` is the server-held authoritative copy (never client-sent).
-- Single-use AND freshness are decided ONLY by the atomic consume's rows-affected, never by a prior read:
--   UPDATE authChallenges SET consumed = 1
--    WHERE challengeId = ?1 AND consumed = 0 AND purpose = ?2 AND expiresAtMs > ?3   -- ?3 = serverNowMs
--    RETURNING nonce, keyId;
-- rows-affected = 1 -> fresh AND first-consumer -> proceed with the returned server-held nonce/keyId.
-- 0 rows -> reject (expired OR already-spent OR wrong-purpose — indistinguishable, all deny).
CREATE TABLE authChallenges (
  challengeId TEXT    NOT NULL PRIMARY KEY,       -- random, >=32B base64url
  nonce       TEXT    NOT NULL,                   -- random, >=32B base64url; server-held
  keyId       TEXT,                               -- NULL for purpose='register' (no key yet)
  purpose     TEXT    NOT NULL CHECK (purpose IN ('register', 'session', 'step-up')),  -- defense-in-depth: closed set
  issuedAt    TEXT    NOT NULL,                   -- ISO-8601 Z, audit-only
  expiresAtMs INTEGER NOT NULL,                   -- epoch-millis — THE freshness gate (instant integer compare)
  consumed    INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))  -- boolean-as-int; reject any other value at the DB edge
);

-- Supports sweepExpiredChallenges(serverNowMs): DELETE WHERE expiresAtMs < serverNowMs.
CREATE INDEX authChallenges_byExpiry ON authChallenges (expiresAtMs);

-- grants registry. The opaque bearer/capability token is stored HASHED (F6) — never raw. Resolution
-- hashes the presented token and looks up by tokenHash; the chokepoint then applies freshness
-- (expiresAtMs instant compare) and revocation (revokedAt presence) itself.
CREATE TABLE grants (
  grantId       TEXT    NOT NULL PRIMARY KEY,     -- random row id (base64url); the resolved grantId on PrincipalVerification
  tokenHash     TEXT    NOT NULL UNIQUE,          -- base64url(SHA-256(token)) — F6. UNIQUE provides the resolve-by-hash index.
  principalKind TEXT    NOT NULL,                 -- PrincipalKindSchema: owner|device|guest|anonymous|agent|plugin
  principalId   TEXT    NOT NULL,                 -- accountFingerprint (owner) | keyId (device) | capability id
  mintedByKeyId TEXT,                             -- device keyId that minted this grant; NULL for capability grants.
                                                  -- Lets revokeByKeyId scope an immediate per-device token deny (PIN-ID-5)
                                                  -- WITHOUT changing the owner/accountFingerprint principal (authz + F2 untouched).
  resourceKind  TEXT    NOT NULL,                 -- 'workspace' | 'notebook' | 'note'
  resourceId    TEXT,                             -- NULL for workspace
  scope         TEXT    NOT NULL,                 -- JSON Scope[] — CLAMPED at mint (F5), never requestedScope verbatim
  expiresAtMs   INTEGER,                          -- epoch-millis, nullable (NULL = no expiry); instant compare at resolve
  revokedAt     TEXT,                             -- ISO-8601 Z; IS NOT NULL = instant deny (PIN-ID-5)
  createdAt     TEXT    NOT NULL                  -- ISO-8601 Z, audit-only
);
-- No separate index on tokenHash: the UNIQUE constraint already creates the index resolveGrantByTokenHash uses.

-- Supports revokeByKeyId's outstanding-token sweep: UPDATE grants SET revokedAt WHERE mintedByKeyId = ?.
CREATE INDEX grants_byMintedKey ON grants (mintedByKeyId);

-- Bump the substrate marker so readiness checks can prove this migration applied.
INSERT INTO meta (key, value) VALUES ('streamAAuthSchemaVersion', '1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
