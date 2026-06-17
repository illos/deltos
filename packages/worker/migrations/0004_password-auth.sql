-- Auth pivot (2026-06-17) — username + password (+ optional TOTP), recovery phrase = reset token.
-- docs/specs/auth-pivot-password.md (FINAL) + the auth-pivot-security-model. ADDITIVE, zero data
-- migration: the D6 account/authz spine (accounts / accountCredentials / usernames / grants / notes.
-- accountId) is KEPT WHOLESALE — note data keys on the stable `accountId`, independent of the credential.
-- This migration only ADDS the password-credential, durable-refresh-session, and abuse-throttle tables.
-- The retired signed-challenge tables (devices, authChallenges) are LEFT in place but go unused under
-- the password model (clean re-enroll, fresh dogfood DB — no rows to migrate).
--
-- CASING: camelCase columns end-to-end (PIN-SUBSTRATE-1 — no snake<->camel mapping at the DB edge),
-- matching 0002/0003. TIMESTAMPS: comparison-critical instants are epoch-MILLIS INTEGER (instant
-- integer compare, never a lexical ISO compare — the AUTH-1 freshness-gate discipline); audit-only
-- times stay ISO-8601-Z TEXT. No CREATE TEMP TABLE anywhere (D1's migration authorizer rejects it,
-- SQLITE_AUTH — [[migration-d1-no-temp-table]]).

-- passwordCredentials — one password credential per ACCOUNT (v1). Keyed on accountId (the stable D6
-- data-ownership key), NOT on a username: a rename never touches the credential, and login resolves
-- username -> accountId via the kept `usernames` table, then loads the credential here.
--
--   passwordPhc   — Argon2id PHC string ($argon2id$v=19$m=..,t=..,p=..$salt$hash). The pepper (a Worker
--                   secret) is HMAC'd into the input BEFORE the hash, so this row alone is NOT offline-
--                   crackable (F6 sibling for passwords).
--   recoveryPhc   — Argon2id verifier for the recovery phrase, KEYED to accountId. Reset compares the
--                   re-typed phrase against this (slow-hash, gated >= login).
--   totpSecretEnc — AES-256-GCM ciphertext (base64url iv||ct) of the 20B TOTP secret under a Worker
--                   secret; NULL = no TOTP secret provisioned. Plaintext secret never lands in D1.
--   totpEnabled   — 0 until a confirm-code activates 2FA (confirm-before-activate, anti-lockout).
--   totpLastStep  — the replay guard: the last accepted TOTP step; a code at/below it is rejected.
CREATE TABLE passwordCredentials (
  accountId     TEXT    NOT NULL PRIMARY KEY,   -- -> accounts.accountId (one credential per account, v1)
  passwordPhc   TEXT    NOT NULL,               -- Argon2id PHC verifier (peppered)
  recoveryPhc   TEXT    NOT NULL,               -- Argon2id recovery-phrase verifier, keyed to accountId
  totpSecretEnc TEXT,                           -- AES-GCM(base64url) of the 20B secret; NULL = none
  totpEnabled   INTEGER NOT NULL DEFAULT 0 CHECK (totpEnabled IN (0, 1)),
  totpLastStep  INTEGER,                        -- replay guard; NULL until first accepted code
  createdAt     TEXT    NOT NULL,               -- ISO-8601 Z, audit-only
  updatedAt     TEXT    NOT NULL                -- ISO-8601 Z, audit-only
);

-- refreshSessions — the DURABLE-session backing store (the ungated-reload mechanism). The refresh
-- token rides an httpOnly+Secure+SameSite=Strict cookie scoped to /refresh; only its HASH is stored
-- here (F6, reuse authCrypto.hashToken — the raw token is never persisted). STATEFUL, not a JWT, so
-- revocation is real:
--   familyId   — the rotation family. rotation-on-use issues a NEW row in the same family and marks
--                the prior `rotatedAt`. Presenting an already-rotated token = REUSE/theft -> revoke the
--                whole family (reuse-detection).
--   rotatedAt  — presence = this token was already spent by a rotation (its successor exists).
--   revokedAt  — presence = dead (logout / reuse-detection / revoke-all on a credential change).
-- expiresAtMs is the durable window (sliding). Revoke-all-families on reset/password-change/logout/
-- 2FA-change keys on accountId.
CREATE TABLE refreshSessions (
  tokenHash   TEXT    NOT NULL PRIMARY KEY,     -- base64url(SHA-256(refreshToken)) — F6, never the raw token
  familyId    TEXT    NOT NULL,                 -- rotation family id (random)
  accountId   TEXT    NOT NULL,                 -- -> accounts.accountId
  issuedAtMs  INTEGER NOT NULL,                 -- epoch-millis, audit
  expiresAtMs INTEGER NOT NULL,                 -- epoch-millis — the durable-window freshness gate
  rotatedAt   TEXT,                             -- ISO-8601 Z; presence = already rotated (successor exists)
  revokedAt   TEXT,                             -- ISO-8601 Z; presence = revoked
  label       TEXT                              -- optional device/session label
);
-- Reuse-detection + revoke-all sweep the family / the account; index both axes.
CREATE INDEX refreshSessions_byFamily ON refreshSessions (familyId);
CREATE INDEX refreshSessions_byAccount ON refreshSessions (accountId);

-- authThrottle — per-key abuse backoff for the unauthenticated login/reset endpoints (the cheap GATE
-- that runs BEFORE Argon2id — AP-4 gate-before-hash, the CPU-amplification-DoS defense). Keyed by a
-- bucket string ("login:<usernameNormalized>" / "reset:<usernameNormalized>" / "ip:<addr>"). The
-- bucket is recorded for ANY attempt regardless of whether the account exists, so the throttle is not
-- an existence oracle. NO hard lockout (a hard lockout is a victim-DoS) — exponential backoff with a
-- cap. This is best-effort rate-limiting, NOT a security invariant (the uniform error + always-hash are);
-- a simple read-modify-write is sufficient.
CREATE TABLE authThrottle (
  bucket        TEXT    NOT NULL PRIMARY KEY,
  failures      INTEGER NOT NULL DEFAULT 0,
  nextAllowedMs INTEGER NOT NULL DEFAULT 0,     -- epoch-millis; an attempt before this instant is gated
  updatedAt     TEXT    NOT NULL
);

-- Substrate marker so readiness checks can prove this migration applied.
INSERT INTO meta (key, value) VALUES ('passwordAuthSchemaVersion', '1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
