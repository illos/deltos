import { z } from 'zod';
import {
  PrincipalSchema,
  ResourceSchema,
  ScopeSchema,
  type Principal,
  type Resource,
  type Scope,
} from '@deltos/shared';
import type { DbAdapter } from './schema.js';

/**
 * authStore — the pure-D1 data layer for Stream A identity (devices / authChallenges / grants,
 * migration 0002). Built 1:1 to the locked contract (docs/design/stream-a-auth-contracts.md §1).
 *
 * It holds NO crypto and NO policy: the chokepoint (devSys's authCrypto + can()) verifies
 * signatures, COMPUTES the F2 fingerprint, hashes tokens, and decides authorization. This layer
 * only reads and writes rows — but it owns two correctness-critical invariants the contract pins:
 *
 *   1. consumeChallenge is the SOLE authority on single-use AND freshness, decided ENTIRELY by the
 *      rows-affected of ONE atomic `UPDATE … WHERE consumed=0 AND expiresAtMs > :now RETURNING`.
 *      There is deliberately NO getChallenge() that reads `consumed`/`expiresAtMs` first — a prior
 *      SELECT reopens the replay window a stale-replica read would miss. `serverNowMs` is the SERVER
 *      clock; no client timestamp ever enters the gate. (AUTH-1 × R3-1 at the storage layer.)
 *   2. grants store the token HASHED (F6) — mint/resolve touch `tokenHash` only, never a raw token.
 *
 * Time: comparison-critical gates (consume freshness, sweep) take `serverNowMs` from the caller —
 * the SAME clock the route reads — so the value that gates a compare is the route's, never this
 * layer's. Audit-only `revokedAt` is stamped here with the server clock (it is NEVER compared),
 * which keeps the revoke call sites exactly as the contract specifies them: revokeGrant(grantId) /
 * revokeByKeyId(keyId).
 */

// Converges to @deltos/shared's AuthPurpose once devSys's canonical.ts lands it as an export; kept
// local for now so this layer doesn't depend on a not-yet-committed module.
export type AuthPurpose = 'register' | 'session' | 'step-up';

/**
 * The outcome of an atomic username claim (D6 directory layer). Discriminated so the route maps each to
 * a status without a second read or a trusted body field:
 *  - `claimed`               → the name was free + the account had none → 201.
 *  - `idempotent`            → this account already holds THIS exact name (a racing/duplicate re-claim) → 200.
 *  - `name-taken`            → the name is held by ANOTHER account → 409 (no holder identity leaked).
 *  - `account-has-username`  → this account already holds a DIFFERENT name (v1 one-per-account, rename OFF) → 409.
 */
export type ClaimUsernameResult =
  | { status: 'claimed' }
  | { status: 'idempotent'; usernameDisplay: string }
  | { status: 'name-taken' }
  | { status: 'account-has-username' };

const ScopeArraySchema = z.array(ScopeSchema);

export interface AuthStore {
  /** Persist a freshly-minted, UNCONSUMED challenge. */
  createChallenge(row: {
    challengeId: string;
    nonce: string;
    keyId: string | null; // NULL for purpose='register' (no key yet)
    purpose: AuthPurpose;
    issuedAt: string; // ISO-8601 Z, audit-only
    expiresAtMs: number; // epoch-millis freshness gate
  }): Promise<void>;

  /**
   * The single authority on single-use AND freshness. Atomic CAS: consumes iff unconsumed, of the
   * matching purpose, and not yet expired vs `serverNowMs`. Returns the server-held `nonce`/`keyId`
   * for TLV reconstruction + the keyId stored==request assert, or null on any miss (expired /
   * already-spent / wrong-purpose — indistinguishable, all reject).
   */
  consumeChallenge(
    challengeId: string,
    purpose: AuthPurpose,
    serverNowMs: number,
  ): Promise<{ nonce: string; keyId: string | null } | null>;

  registerDevice(row: {
    keyId: string;
    signingPublicKey: string; // ACCOUNT-level key (v1: shared across the account's devices)
    // option-(b)/D5 per-device-key seam — REQUIRED (NOT NULL), always populated. The v1 route supplies
    // the account signingPublicKey (strawman F1); Phase-2 supplies the device's own key. No null state.
    deviceSigningPublicKey: string;
    accountFingerprint: string;
    deviceLabel: string;
    createdAt: string; // ISO-8601 Z
  }): Promise<void>;

  getDevice(keyId: string): Promise<{
    signingPublicKey: string;
    accountFingerprint: string;
    revokedAt: string | null; // presence = revoked (session route 401s)
  } | null>;

  listDevices(accountFingerprint: string): Promise<
    Array<{ keyId: string; deviceLabel: string; createdAt: string; revokedAt: string | null }>
  >;

  // --- account-identity (D6, migration 0003) -------------------------------------------------------
  // ACCOUNT (stable, random, credential-INDEPENDENT accountId) vs CREDENTIAL (signing-key fingerprint).
  // accountId is the data-ownership key; accountFingerprint is demoted to one credential id. The route
  // resolves accountId via these and stamps principal.id = accountId at session mint (the re-point).

  /** Create a new account. `accountId` is server-generated random (>=16B) by the caller (authCrypto). */
  createAccount(row: { accountId: string; createdAt: string }): Promise<void>;

  /**
   * Bind a credential (signing-key fingerprint) to an account. BIND-ONCE: the PK on accountFingerprint
   * makes a second bind of the same credential throw — a credential maps to exactly one account, and
   * re-pointing it is forbidden (secSys S2/S3). Binding to an EXISTING account requires possession proof
   * at the route layer; this only records the proven binding.
   */
  bindCredential(row: {
    accountFingerprint: string;
    accountId: string;
    credentialType: string;
    addedAt: string;
  }): Promise<void>;

  /**
   * Resolve a credential fingerprint to its (non-revoked) accountId, or null if unbound/revoked. Used at
   * session mint to stamp `principal.id = accountId` server-side (never a body field) — the re-point.
   */
  resolveAccountIdByFingerprint(accountFingerprint: string): Promise<string | null>;

  /**
   * List an account's devices across ALL its (N:1) credentials. Replaces `listDevices(principal.id)` now
   * that `principal.id` = accountId (not a fingerprint) — the GET /devices re-point.
   */
  listDevicesByAccount(accountId: string): Promise<
    Array<{ keyId: string; deviceLabel: string; createdAt: string; revokedAt: string | null }>
  >;

  /**
   * Atomically claim `usernameNormalized` for `accountId` (the DIRECTORY layer, D6) — the SINGLE atomic
   * authority on BOTH uniqueness axes, with NO check-then-insert on either (the TOCTOU class secSys S1
   * forbids, on the cross-account AND the per-account axis):
   *   - `usernameNormalized` PK     → cross-account name uniqueness (two accounts racing the SAME name).
   *   - `accountId` UNIQUE index    → v1 one-username-per-account (same account racing DIFFERENT names).
   * ONE statement with BOTH as `ON CONFLICT … DO NOTHING` targets, so neither conflict throws; a row
   * returns IFF this call won. The post-conflict point reads run AFTER the atomic claim already failed —
   * not a TOCTOU (the outcome is decided), and not an oracle (taken is only ever surfaced inside this
   * authenticated claim). The caller has already normalized via the shared `normalizeUsername`. The
   * discriminated result lets the route map each outcome to a status WITHOUT trusting a body field.
   */
  claimUsername(row: {
    usernameNormalized: string;
    accountId: string;
    usernameDisplay: string;
    createdAt: string;
  }): Promise<ClaimUsernameResult>;

  /**
   * The username an account currently holds (v1: at most one — rename OFF, one-per-account enforced by
   * the route), or null. Returns both the display + normalized forms so the route can serve an
   * idempotent re-claim and tell "already has a different name" from "first claim".
   */
  getUsernameByAccount(
    accountId: string,
  ): Promise<{ usernameDisplay: string; usernameNormalized: string } | null>;

  /** Persist a minted grant. The token is already HASHED by the caller (F6). */
  mintGrant(row: {
    grantId: string;
    tokenHash: string;
    principal: Principal; // owner/accountFingerprint for a session grant; capability for share-links
    mintedByKeyId: string | null; // the device that minted it (NULL for capability) — scopes revokeByKeyId
    resource: Resource;
    scope: Scope[]; // already CLAMPED at mint (F5)
    expiresAtMs: number | null; // epoch-millis; NULL = no expiry
    createdAt: string; // ISO-8601 Z
  }): Promise<void>;

  /**
   * Resolve by token hash. Returns the row REGARDLESS of revoked/expired state — the chokepoint
   * applies freshness (expiresAtMs instant compare) and revocation (revokedAt presence) itself,
   * so it gets `expiresAtMs` + `revokedAt` back to decide. Null only if no row matches the hash.
   */
  resolveGrantByTokenHash(tokenHash: string): Promise<{
    grantId: string;
    principal: Principal;
    resource: Resource;
    scope: Scope[];
    expiresAtMs: number | null;
    revokedAt: string | null;
  } | null>;

  /** Revoke a single grant by its row id (capability / single-grant revoke). Idempotent. */
  revokeGrant(grantId: string): Promise<void>;

  /**
   * Per-device revocation (PIN-ID-5), atomic in one batch: revoke the device row (blocks FUTURE
   * session mints via the session route's getDevice revoked-check) AND that device's OUTSTANDING
   * grant rows (scoped by mintedByKeyId → immediate deny on the next request bearing those tokens).
   * Idempotent; the owner/accountFingerprint principal is untouched (F1 honest-limit holds).
   */
  revokeByKeyId(keyId: string): Promise<void>;

  /** Reclaim expired challenge rows (the TTL bounds lifetime; this reclaims space). */
  sweepExpiredChallenges(serverNowMs: number): Promise<void>;

  // --- password auth (migration 0004) -------------------------------------------------------------
  // The credential layer for the auth pivot: a per-account password verifier + recovery verifier +
  // optional TOTP, the durable refresh-session store, and the abuse-throttle gate. Keyed on the stable
  // `accountId` (the D6 data-ownership key) — login resolves username -> accountId via `usernames`.

  /** accountId -> the account holding a normalized username, or null. The login/reset identifier path. */
  resolveAccountIdByUsername(usernameNormalized: string): Promise<string | null>;

  /** Create the account's password credential (+ recovery verifier). One per account (PK on accountId). */
  createPasswordCredential(row: {
    accountId: string;
    passwordPhc: string;
    recoveryPhc: string;
    createdAt: string;
  }): Promise<void>;

  /** The account's credential record, or null if it has none. `totpEnabled` is surfaced as a boolean. */
  getCredentialByAccount(accountId: string): Promise<PasswordCredentialRow | null>;

  /** Replace the stored password hash (reset / password-change / rehash-on-login param upgrade). */
  updatePasswordHash(accountId: string, passwordPhc: string, updatedAt: string): Promise<void>;

  /** Replace the recovery verifier (reset re-mints the phrase; phrase rotation). */
  updateRecoveryHash(accountId: string, recoveryPhc: string, updatedAt: string): Promise<void>;

  /** Stash an encrypted TOTP secret WITHOUT enabling 2FA (confirm-before-activate). */
  setTotpSecret(accountId: string, totpSecretEnc: string, updatedAt: string): Promise<void>;

  /** Activate 2FA after a confirm-code verified, stamping the initial replay-guard step. */
  enableTotp(accountId: string, lastAcceptedStep: number, updatedAt: string): Promise<void>;

  /** Disable 2FA: clear the secret, the enabled flag, and the replay guard (reset / explicit disable). */
  disableTotp(accountId: string, updatedAt: string): Promise<void>;

  /** Advance the TOTP replay guard after a code is accepted at login (reject any step <= this next time). */
  advanceTotpStep(accountId: string, lastAcceptedStep: number, updatedAt: string): Promise<void>;

  /** Persist a freshly-minted refresh session (only the token HASH is stored — F6). */
  insertRefreshSession(row: {
    tokenHash: string;
    familyId: string;
    accountId: string;
    issuedAtMs: number;
    expiresAtMs: number;
    label?: string | null;
  }): Promise<void>;

  /** Resolve a refresh session by token hash, REGARDLESS of rotated/revoked/expired — the route decides. */
  getRefreshSession(tokenHash: string): Promise<{
    familyId: string;
    accountId: string;
    expiresAtMs: number;
    rotatedAt: string | null;
    revokedAt: string | null;
  } | null>;

  /** Mark a refresh token spent by a rotation (its successor now exists). Idempotent on rotatedAt. */
  markRefreshRotated(tokenHash: string, rotatedAt: string): Promise<void>;

  /** Reuse-detection: revoke EVERY non-revoked token in a rotation family (a stolen token was replayed). */
  revokeRefreshFamily(familyId: string, revokedAt: string): Promise<void>;

  /**
   * Revoke-all: kill every non-revoked refresh family for an account (fires on the FOUR credential-change
   * events — reset / password-change / logout / 2FA-change). Returns the rows affected so the route/test
   * can assert a real revocation happened.
   */
  revokeAllRefreshForAccount(accountId: string, revokedAt: string): Promise<number>;

  /** Revoke an account's outstanding access grants (owner session tokens) — completes a revoke-all. */
  revokeGrantsByAccount(accountId: string, revokedAt: string): Promise<void>;

  /** Read the abuse-throttle bucket (gate-before-hash), or null if the bucket is clean. */
  getThrottle(bucket: string): Promise<{ failures: number; nextAllowedMs: number } | null>;

  /** Record a failed attempt: bump `failures`, set the next-allowed instant (exponential backoff). Upsert. */
  recordThrottleFailure(bucket: string, failures: number, nextAllowedMs: number, updatedAt: string): Promise<void>;

  /** Clear a throttle bucket after a successful auth (so a legit user is never progressively slowed). */
  clearThrottle(bucket: string): Promise<void>;
}

/** A password credential record (migration 0004). `totpEnabled` is the 0/1 column surfaced as a boolean. */
export interface PasswordCredentialRow {
  accountId: string;
  passwordPhc: string;
  recoveryPhc: string;
  totpSecretEnc: string | null;
  totpEnabled: boolean;
  totpLastStep: number | null;
}

export function createAuthStore(db: DbAdapter): AuthStore {
  return {
    async createChallenge(row) {
      await db.batch([
        {
          sql: `INSERT INTO authChallenges (challengeId, nonce, keyId, purpose, issuedAt, expiresAtMs, consumed)
                VALUES (?, ?, ?, ?, ?, ?, 0)`,
          params: [row.challengeId, row.nonce, row.keyId, row.purpose, row.issuedAt, row.expiresAtMs],
        },
      ]);
    },

    async consumeChallenge(challengeId, purpose, serverNowMs) {
      // ONE indivisible statement. Single-use (consumed=0) AND freshness (expiresAtMs > now) live
      // entirely in this WHERE; the outcome is the rows-affected, surfaced via RETURNING. There is
      // no prior SELECT of consumed/expiresAtMs anywhere — that is the whole point.
      const row = await db.first<{ nonce: string; keyId: string | null }>(
        `UPDATE authChallenges SET consumed = 1
          WHERE challengeId = ? AND consumed = 0 AND purpose = ? AND expiresAtMs > ?
        RETURNING nonce, keyId`,
        [challengeId, purpose, serverNowMs],
      );
      return row ?? null;
    },

    async registerDevice(row) {
      await db.batch([
        {
          sql: `INSERT INTO devices
                  (keyId, signingPublicKey, deviceSigningPublicKey, accountFingerprint, deviceLabel, createdAt, revokedAt)
                VALUES (?, ?, ?, ?, ?, ?, NULL)`,
          params: [
            row.keyId,
            row.signingPublicKey,
            row.deviceSigningPublicKey, // NOT NULL: v1 = signingPublicKey (route), Phase-2 = device key
            row.accountFingerprint,
            row.deviceLabel,
            row.createdAt,
          ],
        },
      ]);
    },

    async getDevice(keyId) {
      const row = await db.first<{
        signingPublicKey: string;
        accountFingerprint: string;
        revokedAt: string | null;
      }>(
        `SELECT signingPublicKey, accountFingerprint, revokedAt FROM devices WHERE keyId = ?`,
        [keyId],
      );
      return row ?? null;
    },

    async listDevices(accountFingerprint) {
      return db.all<{ keyId: string; deviceLabel: string; createdAt: string; revokedAt: string | null }>(
        `SELECT keyId, deviceLabel, createdAt, revokedAt FROM devices
          WHERE accountFingerprint = ? ORDER BY createdAt`,
        [accountFingerprint],
      );
    },

    async createAccount(row) {
      await db.batch([
        {
          sql: `INSERT INTO accounts (accountId, createdAt) VALUES (?, ?)`,
          params: [row.accountId, row.createdAt],
        },
      ]);
    },

    async bindCredential(row) {
      // PK on accountFingerprint enforces bind-once: a duplicate bind of the same credential throws.
      await db.batch([
        {
          sql: `INSERT INTO accountCredentials (accountFingerprint, accountId, credentialType, addedAt, revokedAt)
                VALUES (?, ?, ?, ?, NULL)`,
          params: [row.accountFingerprint, row.accountId, row.credentialType, row.addedAt],
        },
      ]);
    },

    async resolveAccountIdByFingerprint(accountFingerprint) {
      const row = await db.first<{ accountId: string }>(
        `SELECT accountId FROM accountCredentials WHERE accountFingerprint = ? AND revokedAt IS NULL`,
        [accountFingerprint],
      );
      return row?.accountId ?? null;
    },

    async listDevicesByAccount(accountId) {
      return db.all<{ keyId: string; deviceLabel: string; createdAt: string; revokedAt: string | null }>(
        `SELECT keyId, deviceLabel, createdAt, revokedAt FROM devices
          WHERE accountFingerprint IN (SELECT accountFingerprint FROM accountCredentials WHERE accountId = ?)
          ORDER BY createdAt`,
        [accountId],
      );
    },

    async claimUsername(row) {
      // ONE atomic statement, BOTH uniqueness axes as DO-NOTHING conflict targets (neither throws):
      //   usernameNormalized PK   → cross-account name uniqueness
      //   accountId UNIQUE index  → one-username-per-account (closes the per-account TOCTOU)
      // A returned row = we won. No prior SELECT on EITHER axis → no check-then-insert anywhere.
      const won = await db.first<{ accountId: string }>(
        `INSERT INTO usernames (usernameNormalized, accountId, usernameDisplay, createdAt)
              VALUES (?, ?, ?, ?)
         ON CONFLICT(usernameNormalized) DO NOTHING
         ON CONFLICT(accountId) DO NOTHING
         RETURNING accountId`,
        [row.usernameNormalized, row.accountId, row.usernameDisplay, row.createdAt],
      );
      if (won) return { status: 'claimed' };
      // The insert was suppressed by one (or both) conflict(s). Disambiguate with point reads that run
      // AFTER the atomic claim already failed — NOT a TOCTOU (the outcome is decided) and NOT an oracle
      // (taken is only surfaced inside this authenticated claim). Check the account's own row first:
      // accountId is UNIQUE, so this is the account's at-most-one username.
      const mine = await db.first<{ usernameNormalized: string; usernameDisplay: string }>(
        `SELECT usernameNormalized, usernameDisplay FROM usernames WHERE accountId = ?`,
        [row.accountId],
      );
      if (mine) {
        return mine.usernameNormalized === row.usernameNormalized
          ? { status: 'idempotent', usernameDisplay: mine.usernameDisplay } // re-claim of our OWN name
          : { status: 'account-has-username' }; // we already hold a DIFFERENT name (v1 one-per-account)
      }
      // We hold no name → the suppressed conflict was the NAME, held by another account.
      return { status: 'name-taken' };
    },

    async getUsernameByAccount(accountId) {
      const row = await db.first<{ usernameDisplay: string; usernameNormalized: string }>(
        `SELECT usernameDisplay, usernameNormalized FROM usernames
          WHERE accountId = ? ORDER BY createdAt, usernameNormalized LIMIT 1`,
        [accountId],
      );
      return row ?? null;
    },

    async mintGrant(row) {
      const resourceId = row.resource.kind === 'workspace' ? null : row.resource.id;
      await db.batch([
        {
          sql: `INSERT INTO grants
                  (grantId, tokenHash, principalKind, principalId, mintedByKeyId,
                   resourceKind, resourceId, scope, expiresAtMs, revokedAt, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          params: [
            row.grantId,
            row.tokenHash,
            row.principal.kind,
            row.principal.id,
            row.mintedByKeyId,
            row.resource.kind,
            resourceId,
            JSON.stringify(row.scope),
            row.expiresAtMs,
            row.createdAt,
          ],
        },
      ]);
    },

    async resolveGrantByTokenHash(tokenHash) {
      const row = await db.first<{
        grantId: string;
        principalKind: string;
        principalId: string;
        resourceKind: string;
        resourceId: string | null;
        scope: string;
        expiresAtMs: number | null;
        revokedAt: string | null;
      }>(
        `SELECT grantId, principalKind, principalId, resourceKind, resourceId, scope, expiresAtMs, revokedAt
           FROM grants WHERE tokenHash = ?`,
        [tokenHash],
      );
      if (!row) return null;
      // Fail-closed read: a row that does not parse to a valid principal/resource/scope throws here
      // rather than handing a malformed grant to the chokepoint (DB read is a boundary).
      // ⚠ RE-POINT (migration 0003): for owner/device grants `principalId` MEANS `accountId`, NOT a
      // credential fingerprint — so the resolved `principal.id` is the account key the data layer scopes
      // by. The minting credential/device is tracked separately on `mintedByKeyId`. Never treat this id
      // as a fingerprint. (capability grants keep a capability id in principalId.)
      const principal = PrincipalSchema.parse({ kind: row.principalKind, id: row.principalId });
      const resource = ResourceSchema.parse(
        row.resourceKind === 'workspace'
          ? { kind: 'workspace' }
          : { kind: row.resourceKind, id: row.resourceId },
      );
      const scope = ScopeArraySchema.parse(JSON.parse(row.scope));
      return {
        grantId: row.grantId,
        principal,
        resource,
        scope,
        expiresAtMs: row.expiresAtMs,
        revokedAt: row.revokedAt,
      };
    },

    async revokeGrant(grantId) {
      const now = new Date().toISOString();
      await db.batch([
        {
          sql: `UPDATE grants SET revokedAt = ? WHERE grantId = ? AND revokedAt IS NULL`,
          params: [now, grantId],
        },
      ]);
    },

    async revokeByKeyId(keyId) {
      // One batch = one transaction: device-row revoke + outstanding-grant revoke land together or
      // not at all. `revokedAt IS NULL` makes both idempotent — re-revoking is a no-op that keeps
      // the first revoke time.
      const now = new Date().toISOString();
      await db.batch([
        {
          sql: `UPDATE devices SET revokedAt = ? WHERE keyId = ? AND revokedAt IS NULL`,
          params: [now, keyId],
        },
        {
          sql: `UPDATE grants SET revokedAt = ? WHERE mintedByKeyId = ? AND revokedAt IS NULL`,
          params: [now, keyId],
        },
      ]);
    },

    async sweepExpiredChallenges(serverNowMs) {
      await db.batch([
        {
          sql: `DELETE FROM authChallenges WHERE expiresAtMs < ?`,
          params: [serverNowMs],
        },
      ]);
    },

    // --- password auth (migration 0004) -----------------------------------------------------------

    async resolveAccountIdByUsername(usernameNormalized) {
      const row = await db.first<{ accountId: string }>(
        `SELECT accountId FROM usernames WHERE usernameNormalized = ?`,
        [usernameNormalized],
      );
      return row?.accountId ?? null;
    },

    async createPasswordCredential(row) {
      await db.batch([
        {
          sql: `INSERT INTO passwordCredentials
                  (accountId, passwordPhc, recoveryPhc, totpSecretEnc, totpEnabled, totpLastStep, createdAt, updatedAt)
                VALUES (?, ?, ?, NULL, 0, NULL, ?, ?)`,
          params: [row.accountId, row.passwordPhc, row.recoveryPhc, row.createdAt, row.createdAt],
        },
      ]);
    },

    async getCredentialByAccount(accountId) {
      const row = await db.first<{
        accountId: string;
        passwordPhc: string;
        recoveryPhc: string;
        totpSecretEnc: string | null;
        totpEnabled: number;
        totpLastStep: number | null;
      }>(
        `SELECT accountId, passwordPhc, recoveryPhc, totpSecretEnc, totpEnabled, totpLastStep
           FROM passwordCredentials WHERE accountId = ?`,
        [accountId],
      );
      if (!row) return null;
      return {
        accountId: row.accountId,
        passwordPhc: row.passwordPhc,
        recoveryPhc: row.recoveryPhc,
        totpSecretEnc: row.totpSecretEnc,
        totpEnabled: row.totpEnabled === 1,
        totpLastStep: row.totpLastStep,
      };
    },

    async updatePasswordHash(accountId, passwordPhc, updatedAt) {
      await db.batch([
        {
          sql: `UPDATE passwordCredentials SET passwordPhc = ?, updatedAt = ? WHERE accountId = ?`,
          params: [passwordPhc, updatedAt, accountId],
        },
      ]);
    },

    async updateRecoveryHash(accountId, recoveryPhc, updatedAt) {
      await db.batch([
        {
          sql: `UPDATE passwordCredentials SET recoveryPhc = ?, updatedAt = ? WHERE accountId = ?`,
          params: [recoveryPhc, updatedAt, accountId],
        },
      ]);
    },

    async setTotpSecret(accountId, totpSecretEnc, updatedAt) {
      // Stash the secret but do NOT enable — confirm-before-activate (anti-lockout). Also resets the
      // replay guard for the fresh secret so the confirm code is not pre-emptively gated.
      await db.batch([
        {
          sql: `UPDATE passwordCredentials
                   SET totpSecretEnc = ?, totpEnabled = 0, totpLastStep = NULL, updatedAt = ?
                 WHERE accountId = ?`,
          params: [totpSecretEnc, updatedAt, accountId],
        },
      ]);
    },

    async enableTotp(accountId, lastAcceptedStep, updatedAt) {
      await db.batch([
        {
          sql: `UPDATE passwordCredentials SET totpEnabled = 1, totpLastStep = ?, updatedAt = ? WHERE accountId = ?`,
          params: [lastAcceptedStep, updatedAt, accountId],
        },
      ]);
    },

    async disableTotp(accountId, updatedAt) {
      await db.batch([
        {
          sql: `UPDATE passwordCredentials
                   SET totpSecretEnc = NULL, totpEnabled = 0, totpLastStep = NULL, updatedAt = ?
                 WHERE accountId = ?`,
          params: [updatedAt, accountId],
        },
      ]);
    },

    async advanceTotpStep(accountId, lastAcceptedStep, updatedAt) {
      // Only ever move the guard FORWARD (a concurrent login must not roll it back and reopen replay).
      await db.batch([
        {
          sql: `UPDATE passwordCredentials
                   SET totpLastStep = ?, updatedAt = ?
                 WHERE accountId = ? AND (totpLastStep IS NULL OR totpLastStep < ?)`,
          params: [lastAcceptedStep, updatedAt, accountId, lastAcceptedStep],
        },
      ]);
    },

    async insertRefreshSession(row) {
      await db.batch([
        {
          sql: `INSERT INTO refreshSessions
                  (tokenHash, familyId, accountId, issuedAtMs, expiresAtMs, rotatedAt, revokedAt, label)
                VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
          params: [
            row.tokenHash,
            row.familyId,
            row.accountId,
            row.issuedAtMs,
            row.expiresAtMs,
            row.label ?? null,
          ],
        },
      ]);
    },

    async getRefreshSession(tokenHash) {
      const row = await db.first<{
        familyId: string;
        accountId: string;
        expiresAtMs: number;
        rotatedAt: string | null;
        revokedAt: string | null;
      }>(
        `SELECT familyId, accountId, expiresAtMs, rotatedAt, revokedAt
           FROM refreshSessions WHERE tokenHash = ?`,
        [tokenHash],
      );
      return row ?? null;
    },

    async markRefreshRotated(tokenHash, rotatedAt) {
      await db.batch([
        {
          sql: `UPDATE refreshSessions SET rotatedAt = ? WHERE tokenHash = ? AND rotatedAt IS NULL`,
          params: [rotatedAt, tokenHash],
        },
      ]);
    },

    async revokeRefreshFamily(familyId, revokedAt) {
      await db.batch([
        {
          sql: `UPDATE refreshSessions SET revokedAt = ? WHERE familyId = ? AND revokedAt IS NULL`,
          params: [revokedAt, familyId],
        },
      ]);
    },

    async revokeAllRefreshForAccount(accountId, revokedAt) {
      const [res] = await db.batch([
        {
          sql: `UPDATE refreshSessions SET revokedAt = ? WHERE accountId = ? AND revokedAt IS NULL`,
          params: [revokedAt, accountId],
        },
      ]);
      return res?.rowsWritten ?? 0;
    },

    async revokeGrantsByAccount(accountId, revokedAt) {
      // Owner session grants carry principalId = accountId (the re-point). Killing them completes a
      // revoke-all so a stolen in-memory access token also dies, not just the refresh families.
      await db.batch([
        {
          sql: `UPDATE grants SET revokedAt = ?
                 WHERE principalKind = 'owner' AND principalId = ? AND revokedAt IS NULL`,
          params: [revokedAt, accountId],
        },
      ]);
    },

    async getThrottle(bucket) {
      const row = await db.first<{ failures: number; nextAllowedMs: number }>(
        `SELECT failures, nextAllowedMs FROM authThrottle WHERE bucket = ?`,
        [bucket],
      );
      return row ?? null;
    },

    async recordThrottleFailure(bucket, failures, nextAllowedMs, updatedAt) {
      await db.batch([
        {
          sql: `INSERT INTO authThrottle (bucket, failures, nextAllowedMs, updatedAt)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(bucket) DO UPDATE SET
                  failures = excluded.failures,
                  nextAllowedMs = excluded.nextAllowedMs,
                  updatedAt = excluded.updatedAt`,
          params: [bucket, failures, nextAllowedMs, updatedAt],
        },
      ]);
    },

    async clearThrottle(bucket) {
      await db.batch([{ sql: `DELETE FROM authThrottle WHERE bucket = ?`, params: [bucket] }]);
    },
  };
}
