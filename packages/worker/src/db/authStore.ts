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

/** A row to append to the P3 `auditLog` projection (the user-facing audit mirror). */
export interface AuditLogRow {
  accountId: string;
  ts: string;
  surface: string;
  action: string;
  result: string;
  principalKind: string;
  credentialRef: string | null;
  resourceKind: string | null;
  resourceId: string | null;
  ip: string | null;
  country: string | null;
  userAgent: string | null;
  detail: string | null;
}

/** A read-back audit entry for the "Account activity" view (the auto-increment id doubles as a stable key). */
export interface AuditLogEntry extends AuditLogRow {
  id: number;
}

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
   * Delete a freshly-created account that never bound a credential/username/data — the signup
   * orphan-cleanup path (secSys hygiene): when a username claim loses the race to "taken", the account
   * row created moments earlier is reaped inline so no unreachable orphan accumulates (no sweep job).
   * Guarded to rows with NO credential so it can never delete a live account.
   */
  deleteOrphanAccount(accountId: string): Promise<void>;

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
    // The refresh SESSION family this access grant belongs to (Phase 2 — sessions management, migration
    // 0014). NULL for grants not minted by a session (e.g. agent tokens go through insertAgentGrant, which
    // never lists familyId). Lets revokeSessionFamilyForAccount kill this grant when its session is revoked.
    familyId?: string | null;
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

  // --- agent tokens (llm-mcp-integration.md §5, label column migration 0013) ----------------------
  // An agent token is a `grants` row with principalKind='agent', non-expiring (expiresAtMs NULL),
  // scope CLAMPED read-only at mint, principalId = the OWNER's accountId (so the data layer scopes it to
  // that account and the can() ownership belt matches). These three methods are account-scoped by
  // construction — the route NEVER trusts a body accountId; it passes the server-derived principal.id.

  /**
   * Persist a freshly-minted agent grant. The token is already HASHED by the caller (F6) and the scope is
   * already CLAMPED read-only. `accountId` is the OWNER's `principal.id` (server-derived) — it lands in
   * `principalId` so reads scope to that account. expiresAtMs is always NULL (non-expiring); mintedByKeyId
   * NULL (not device-key-scoped). `label` is optional/cosmetic.
   */
  insertAgentGrant(row: {
    grantId: string;
    tokenHash: string;
    accountId: string;
    label: string | null;
    resource: Resource;
    scope: Scope[]; // already CLAMPED read-only at the route
    createdAt: string; // ISO-8601 Z
  }): Promise<void>;

  /**
   * List an account's ACTIVE (revokedAt IS NULL) agent grants. Returns ONLY non-secret metadata — never
   * the tokenHash, never the raw token (which is unrecoverable anyway). Account-scoped on principalId.
   */
  listAgentGrantsForAccount(accountId: string): Promise<
    Array<{
      grantId: string;
      label: string | null;
      scope: Scope[];
      resourceKind: 'workspace' | 'notebook';
      resourceId: string | null;
      createdAt: string;
    }>
  >;

  /**
   * BOLA-CRITICAL revoke: set revokedAt on an agent grant ONLY when it is owned by `accountId`. The
   * account match is IN the WHERE clause, so account B can never revoke account A's token — a non-matching
   * (grantId, accountId) revokes zero rows and the route maps that to 404 (no existence disclosure).
   * Returns the rows affected so the route can distinguish "revoked" from "not yours / not found".
   * Scoped to principalKind='agent' so this can never touch an owner session grant.
   */
  revokeAgentGrantForAccount(grantId: string, accountId: string): Promise<number>;

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

  /**
   * Mark the recovery-phrase save-ack ceremony complete (the P0 BELT — migration 0005). Set TRUE at
   * FINALIZE; until then a login forces the fresh-phrase screen. Idempotent.
   */
  setRecoveryEstablished(accountId: string, established: boolean, updatedAt: string): Promise<void>;

  /**
   * #50 RECOVERY-REKEY HARDENING. The recovery verifier folds accountId into its Argon2id pre-image
   * (`peppered(['recovery', accountId, normalize(phrase)])`, AP-T10 — secSys-reviewed, INTENTIONAL, do
   * NOT de-key). So if an account's accountId is ever RE-KEYED, the stored recoveryPhc — hashed under the
   * OLD id — no longer verifies under the new id, silently stranding recovery-phrase reset (a 100%-correct
   * phrase 401s). The phrase is one-way (no plaintext on the server), so it CANNOT be re-hashed to the new
   * id. The ONLY correct response (secSys #76) is to RE-ESTABLISH: this atomically blanks the verifier to
   * the unestablished sentinel AND clears recoveryEstablished, so the P0 belt forces a fresh
   * /recovery/rotate (which re-keys recoveryPhc to the NEW accountId) before entry — recovery follows the
   * key. Never silently re-hashes, never leaves stale-works-then-breaks, never silent-disabled.
   *
   * FAIL-CLOSED CONTRACT: accountId is IMMUTABLE today (server-random at signup; no runtime re-key path
   * exists — only the one-time migration 0003 fingerprint→accountId re-point, the historical stranding
   * source). IF any future migration or feature ever re-keys an accountId, it MUST call this for that
   * account. SYMMETRY: only RECOVERY needs this — password (peppered(['password', password])) and the
   * TOTP secret (AES-GCM under the global TOTP_ENC_KEY) are accountId-INDEPENDENT and survive a re-key.
   */
  invalidateRecoveryForRekey(accountId: string, unestablishedVerifier: string, updatedAt: string): Promise<void>;

  /**
   * FINALIZE atomically (secSys (b)): set `recoveryEstablished=true` AND insert the durable refresh
   * session in ONE transaction (one db.batch), so the BELT flag and the SUSPENDERS cookie-backing row
   * can never diverge — there is no window where a durable session exists for an account whose recovery
   * is not yet established (the exact gap the cold-boot fail-safe rests on). The route sets the cookie
   * header after this commits.
   */
  finalizeRecovery(row: {
    accountId: string;
    tokenHash: string;
    familyId: string;
    issuedAtMs: number;
    expiresAtMs: number;
    updatedAt: string;
  }): Promise<void>;

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
    // The device label captured at the ORIGINAL fresh-device login. Returned so a rotation can carry it
    // forward into the successor row (the label is uniform across a family). NULL for pre-label sessions.
    label: string | null;
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

  // --- sessions management (Phase 2 — "Active sessions", migration 0014) --------------------------
  // The list / revoke-one / sign-out-others surface. Every method here is BOLA-scoped on the SERVER-
  // derived caller `accountId` (never a body/path field): a caller can only see/revoke ITS OWN sessions.
  // The 0014 grant.familyId link lets a session revoke ALSO kill that session's outstanding access token
  // in the same batch (immediate, not after the access-token TTL). Agent tokens carry NULL familyId, so
  // the "others" sweep (which targets owner grants with a non-NULL familyId) can never touch them.

  /**
   * One row per ACTIVE refresh family for the account — a family with a live HEAD (rotatedAt IS NULL AND
   * revokedAt IS NULL AND expiresAtMs > now). `createdAtMs` = MIN(issuedAtMs) over the family (the ORIGINAL
   * login instant, not the last rotation); `label` = MAX(label) (uniform across a family; MAX skips NULLs).
   * Account-scoped on accountId. Ordered newest-first.
   */
  listRefreshSessionsForAccount(
    accountId: string,
    serverNowMs: number,
  ): Promise<Array<{ familyId: string; label: string | null; createdAtMs: number }>>;

  /**
   * BOLA-CRITICAL revoke-one (a session). In ONE batch: revoke every non-revoked refresh row in the family
   * AND the family's outstanding access grant — both scoped to `accountId`/`principalId` so account B can
   * never revoke account A's session (a non-matching family revokes ZERO refresh rows → the route 404s, no
   * existence disclosure). Returns the number of REFRESH rows revoked (the existence/ownership signal).
   */
  revokeSessionFamilyForAccount(familyId: string, accountId: string, revokedAt: string): Promise<number>;

  /**
   * Sign-out-OTHERS: revoke every refresh family for the account EXCEPT `exceptFamilyId`, and every
   * OWNER access grant linked to a (non-NULL, != current) family. Agent tokens (NULL familyId) are
   * untouched, and the current session's own refresh + grant survive. Returns the number of OTHER refresh
   * rows revoked.
   */
  revokeOtherSessionsForAccount(
    accountId: string,
    exceptFamilyId: string,
    revokedAt: string,
  ): Promise<number>;

  /** The refresh family an access grant belongs to (Phase 2 current-session detection), or null. */
  getGrantFamilyId(grantId: string): Promise<string | null>;

  /**
   * P3 audit projection (ROAD-0005) — append ONE row to the user-facing `auditLog` D1 mirror. The
   * tamper-proof record is the AE dataset (audit.ts); this is the queryable copy for the "Account
   * activity" view. Called only for the security-meaningful subset (audit.ts decides what projects).
   */
  insertAuditLog(row: AuditLogRow): Promise<void>;

  /**
   * The account's recent activity, newest-first, capped at `limit`. Account-scoped on accountId (BOLA-safe:
   * a caller sees ONLY their own events). Feeds the lazy "Account activity" Settings view.
   */
  listAuditLogForAccount(accountId: string, limit: number): Promise<AuditLogEntry[]>;

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
  /** P0 BELT (0005): false until the phrase-ack ceremony completes at FINALIZE. */
  recoveryEstablished: boolean;
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
      // ⚠️ accountId IMMUTABILITY CONTRACT (#50, secSys #76/#201). accountId is server-random and FIXED
      // for the life of the account. NOTHING re-keys it at runtime — the ONLY `SET accountId` ever was the
      // one-time migration 0003 fingerprint→accountId re-point (which silently stranded recovery on the
      // pre-existing dogfood account, the 2026-06-20 reset-401 root). IF you EVER add a path that mutates
      // an account's accountId (a future migration, account-merge, add-credential, or credential-rebind),
      // you MUST call `invalidateRecoveryForRekey(accountId, UNESTABLISHED_VERIFIER, now)` for that account
      // in the same change — the recovery verifier folds accountId into its pre-image (AP-T10) and CANNOT
      // be re-hashed (one-way), so it must be invalidated → re-established under the new key. Password and
      // the TOTP secret are accountId-INDEPENDENT and need nothing. See invalidateRecoveryForRekey above.
      await db.batch([
        {
          sql: `INSERT INTO accounts (accountId, createdAt) VALUES (?, ?)`,
          params: [row.accountId, row.createdAt],
        },
      ]);
    },

    async deleteOrphanAccount(accountId) {
      // Fail-safe: only delete an account with NO password credential (and the route only calls this on
      // an account it created microseconds earlier that lost the username race) — never a live account.
      await db.batch([
        {
          sql: `DELETE FROM accounts
                 WHERE accountId = ?
                   AND NOT EXISTS (SELECT 1 FROM passwordCredentials WHERE accountId = ?)`,
          params: [accountId, accountId],
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
                   resourceKind, resourceId, scope, expiresAtMs, revokedAt, createdAt, familyId)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
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
            row.familyId ?? null, // links the access grant to its refresh session family (0014); NULL otherwise
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

    async insertAgentGrant(row) {
      const resourceId = row.resource.kind === 'workspace' ? null : row.resource.id;
      await db.batch([
        {
          sql: `INSERT INTO grants
                  (grantId, tokenHash, principalKind, principalId, mintedByKeyId,
                   resourceKind, resourceId, scope, expiresAtMs, revokedAt, createdAt, label)
                VALUES (?, ?, 'agent', ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
          params: [
            row.grantId,
            row.tokenHash,
            row.accountId, // principalId = OWNER accountId (server-derived; reads scope to this account)
            row.resource.kind,
            resourceId,
            JSON.stringify(row.scope), // already CLAMPED read-only at the route
            row.createdAt,
            row.label,
          ],
        },
      ]);
    },

    async listAgentGrantsForAccount(accountId) {
      const rows = await db.all<{
        grantId: string;
        label: string | null;
        scope: string;
        resourceKind: string;
        resourceId: string | null;
        createdAt: string;
      }>(
        `SELECT grantId, label, scope, resourceKind, resourceId, createdAt
           FROM grants
          WHERE principalKind = 'agent' AND principalId = ? AND revokedAt IS NULL
          ORDER BY createdAt`,
        [accountId],
      );
      return rows.map((r) => ({
        grantId: r.grantId,
        label: r.label,
        // Parse + re-validate the stored scope at this read boundary (fail-closed on a malformed row).
        scope: ScopeArraySchema.parse(JSON.parse(r.scope)),
        // resourceKind is constrained to workspace|notebook at mint (agent tokens never scope to a note).
        resourceKind: (r.resourceKind === 'notebook' ? 'notebook' : 'workspace') as 'workspace' | 'notebook',
        resourceId: r.resourceId,
        createdAt: r.createdAt,
      }));
    },

    async revokeAgentGrantForAccount(grantId, accountId) {
      // The account match is IN the WHERE — a row owned by another account matches zero rows (BOLA). Scoped
      // to principalKind='agent' so it can never revoke an owner session grant. Idempotent re-revoke = 0 rows.
      const now = new Date().toISOString();
      const [res] = await db.batch([
        {
          sql: `UPDATE grants SET revokedAt = ?
                 WHERE grantId = ? AND principalKind = 'agent' AND principalId = ? AND revokedAt IS NULL`,
          params: [now, grantId, accountId],
        },
      ]);
      return res?.rowsWritten ?? 0;
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
        recoveryEstablished: number;
      }>(
        `SELECT accountId, passwordPhc, recoveryPhc, totpSecretEnc, totpEnabled, totpLastStep, recoveryEstablished
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
        recoveryEstablished: row.recoveryEstablished === 1,
      };
    },

    async setRecoveryEstablished(accountId, established, updatedAt) {
      await db.batch([
        {
          sql: `UPDATE passwordCredentials SET recoveryEstablished = ?, updatedAt = ? WHERE accountId = ?`,
          params: [established ? 1 : 0, updatedAt, accountId],
        },
      ]);
    },

    async finalizeRecovery(row) {
      // ONE batch = ONE transaction: the BELT flag and the durable-session row land together or not at all.
      await db.batch([
        {
          sql: `UPDATE passwordCredentials SET recoveryEstablished = 1, updatedAt = ? WHERE accountId = ?`,
          params: [row.updatedAt, row.accountId],
        },
        {
          sql: `INSERT INTO refreshSessions
                  (tokenHash, familyId, accountId, issuedAtMs, expiresAtMs, rotatedAt, revokedAt, label)
                VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
          params: [row.tokenHash, row.familyId, row.accountId, row.issuedAtMs, row.expiresAtMs],
        },
      ]);
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

    async invalidateRecoveryForRekey(accountId, unestablishedVerifier, updatedAt) {
      // #50: blank the verifier to the canonical UNESTABLISHED sentinel AND clear recoveryEstablished in
      // ONE UPDATE (atomic — never a window where the flag and the verifier disagree, preserving the
      // AP-T10/finalize invariant "recoveryEstablished=1 ⟹ a real PHC verifier exists"). The caller
      // passes the SAME sentinel createPasswordCredential/signup uses, so /reset routes it through
      // isPhc()→false → dummyRecoveryHash → fail() — byte-identical to the proven unestablished path — and
      // the P0 belt forces a fresh /recovery/rotate at next login (recovery re-keys to the new accountId).
      // Idempotent: a harmless no-op on an already-unestablished account.
      await db.batch([
        {
          sql: `UPDATE passwordCredentials SET recoveryPhc = ?, recoveryEstablished = 0, updatedAt = ? WHERE accountId = ?`,
          params: [unestablishedVerifier, updatedAt, accountId],
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
        label: string | null;
      }>(
        `SELECT familyId, accountId, expiresAtMs, rotatedAt, revokedAt, label
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
      // H3 (ROAD-0005 P0): ALSO sweep principalKind='agent'. Agent tokens carry principalId = owner
      // accountId and are non-expiring BY DESIGN (no TTL — revocability is the control, Jim 2026-06-29),
      // so a credential change / revoke-all MUST kill outstanding agent tokens too — otherwise a leaked
      // token survives the exact "I think I'm compromised, reset everything" action meant to kill it.
      await db.batch([
        {
          sql: `UPDATE grants SET revokedAt = ?
                 WHERE principalKind IN ('owner', 'agent') AND principalId = ? AND revokedAt IS NULL`,
          params: [revokedAt, accountId],
        },
      ]);
    },

    // --- sessions management (Phase 2 — migration 0014) -------------------------------------------

    async listRefreshSessionsForAccount(accountId, serverNowMs) {
      // One query: pick the families whose HEAD is live (unrotated, unrevoked, unexpired), then aggregate
      // the WHOLE family for the original-login instant (MIN issuedAtMs) + the uniform label (MAX skips
      // NULLs). Account-scoped on accountId in BOTH the inner liveness filter and the outer aggregate so
      // it is BOLA-safe by construction. newest-first.
      const rows = await db.all<{ familyId: string; createdAtMs: number; label: string | null }>(
        `SELECT familyId, MIN(issuedAtMs) AS createdAtMs, MAX(label) AS label
           FROM refreshSessions
          WHERE accountId = ? AND familyId IN (
            SELECT familyId FROM refreshSessions
             WHERE accountId = ? AND rotatedAt IS NULL AND revokedAt IS NULL AND expiresAtMs > ?)
          GROUP BY familyId
          ORDER BY createdAtMs DESC`,
        [accountId, accountId, serverNowMs],
      );
      return rows.map((r) => ({ familyId: r.familyId, label: r.label, createdAtMs: r.createdAtMs }));
    },

    async revokeSessionFamilyForAccount(familyId, accountId, revokedAt) {
      // ONE batch = ONE transaction. The refresh-row UPDATE carries the account match IN its WHERE, so a
      // family owned by another account revokes ZERO refresh rows (BOLA) — and the returned count (from the
      // refresh UPDATE only) is what the route 404s on. The grant UPDATE kills the session's outstanding
      // access token immediately (scoped to principalId=accountId + this familyId).
      const [refreshRes] = await db.batch([
        {
          sql: `UPDATE refreshSessions SET revokedAt = ?
                 WHERE familyId = ? AND accountId = ? AND revokedAt IS NULL`,
          params: [revokedAt, familyId, accountId],
        },
        {
          sql: `UPDATE grants SET revokedAt = ?
                 WHERE familyId = ? AND principalId = ? AND revokedAt IS NULL`,
          params: [revokedAt, familyId, accountId],
        },
      ]);
      return refreshRes?.rowsWritten ?? 0;
    },

    async revokeOtherSessionsForAccount(accountId, exceptFamilyId, revokedAt) {
      // Revoke every OTHER family's refresh rows + their linked OWNER access grants in one batch. The grant
      // sweep is gated on `familyId IS NOT NULL AND familyId != current` so it can NEVER touch an agent
      // token (NULL familyId) nor the current session. Returns the count of OTHER refresh rows revoked.
      const [refreshRes] = await db.batch([
        {
          sql: `UPDATE refreshSessions SET revokedAt = ?
                 WHERE accountId = ? AND familyId != ? AND revokedAt IS NULL`,
          params: [revokedAt, accountId, exceptFamilyId],
        },
        {
          sql: `UPDATE grants SET revokedAt = ?
                 WHERE principalId = ? AND principalKind = 'owner'
                   AND familyId IS NOT NULL AND familyId != ? AND revokedAt IS NULL`,
          params: [revokedAt, accountId, exceptFamilyId],
        },
      ]);
      return refreshRes?.rowsWritten ?? 0;
    },

    async getGrantFamilyId(grantId) {
      const row = await db.first<{ familyId: string | null }>(
        `SELECT familyId FROM grants WHERE grantId = ?`,
        [grantId],
      );
      return row?.familyId ?? null;
    },

    async insertAuditLog(row) {
      await db.batch([
        {
          sql: `INSERT INTO auditLog
                  (accountId, ts, surface, action, result, principalKind, credentialRef,
                   resourceKind, resourceId, ip, country, userAgent, detail)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            row.accountId, row.ts, row.surface, row.action, row.result, row.principalKind,
            row.credentialRef, row.resourceKind, row.resourceId, row.ip, row.country,
            row.userAgent, row.detail,
          ],
        },
      ]);
    },

    async listAuditLogForAccount(accountId, limit) {
      // Account-scoped (BOLA-safe) + newest-first via the (accountId, id DESC) index. `limit` is bounded
      // by the route so a caller can't request an unbounded scan.
      const rows = await db.all<AuditLogEntry>(
        `SELECT id, accountId, ts, surface, action, result, principalKind, credentialRef,
                resourceKind, resourceId, ip, country, userAgent, detail
           FROM auditLog
          WHERE accountId = ?
          ORDER BY id DESC
          LIMIT ?`,
        [accountId, limit],
      );
      return rows;
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
