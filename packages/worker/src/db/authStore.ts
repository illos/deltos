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
const ResourceArraySchema = z.array(ResourceSchema);

/**
 * One resolved grant row (a single resource of a possibly-multi-resource token). `tokenGroupId` groups the
 * rows minted together into one logical token (grant sets, ROAD-0011 P1); it is NULL on pre-grant-set /
 * session / capability rows, where each row is its own token. Returned REGARDLESS of revoked/expired state —
 * the chokepoint decides liveness.
 */
export interface ResolvedGrantRow {
  grantId: string;
  tokenGroupId: string | null;
  principal: Principal;
  resource: Resource;
  scope: Scope[];
  expiresAtMs: number | null;
  revokedAt: string | null;
}

/** One resource in a non-secret token view — the per-resource grant row id + its addressed resource. */
export interface AgentGrantResourceRow {
  grantId: string;
  kind: 'workspace' | 'notebook' | 'note';
  id: string | null;
}

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
   *
   * ⚠ With grant SETS (ROAD-0011 P1) a token hash can map to MANY rows (one per resource). This singular
   * form returns an ARBITRARY matching row — kept for callers that resolve UNIQUE-hash grants (owner
   * sessions) and only need a representative. The chokepoint uses {@link resolveGrantsByTokenHash}.
   */
  resolveGrantByTokenHash(tokenHash: string): Promise<ResolvedGrantRow | null>;

  /**
   * Resolve ALL grant rows sharing a token hash — the grant-set resolver (ROAD-0011 P1 §1.2). An agent token
   * scoped to several notebooks/notes is N rows sharing one tokenHash + tokenGroupId; the chokepoint evaluates
   * them ANY-OF. Returns every matching row REGARDLESS of revoked/expired (the chokepoint applies liveness);
   * an empty array = no match. Single-resource grants (sessions, capability, workspace agent tokens) resolve
   * to a one-element array, so the any-of degenerates to today's single-grant decision.
   */
  resolveGrantsByTokenHash(tokenHash: string): Promise<ResolvedGrantRow[]>;

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
    // OAuth-issued tokens set this to the registered oauthClient.clientId (migration 0017); first-party
    // Settings-minted tokens leave it null. The grant stays principalKind='agent' either way, so revoke-all
    // covers it; clientId only adds per-client revoke + the Connected-apps listing. Defaults null.
    clientId?: string | null;
  }): Promise<void>;

  /**
   * Persist a GRANT SET — N agent grant rows sharing ONE `tokenHash` and ONE `tokenGroupId` (the mint event),
   * one row per resource (ROAD-0011 P1 §1.2). All rows carry the SAME principal (owner accountId), scope
   * (clamped at the route), and createdAt; they differ only in resourceKind/resourceId and their own grantId
   * (so per-resource revocation is a single-row revoke). Inserted in ONE batch (atomic mint). `tokenHash`
   * being shared is exactly why the 0002 UNIQUE(tokenHash) constraint was dropped (migration 0020).
   */
  insertAgentGrantSet(row: {
    tokenGroupId: string;
    tokenHash: string;
    accountId: string;
    label: string | null;
    scope: Scope[]; // already CLAMPED at the route
    createdAt: string; // ISO-8601 Z
    clientId?: string | null;
    // Access-token expiry. Omitted/NULL = non-expiring (first-party manual agent tokens — unchanged). The
    // OAuth rotating path (oauth-provider.md §5) passes a 1h expiry so the access token is short-lived.
    expiresAtMs?: number | null;
    // The refresh-rotation family this access grant belongs to (grants.familyId, migration 0014). Omitted/NULL
    // for first-party agent tokens. OAuth passes it so a family-nuke (theft) revokes this access grant too.
    familyId?: string | null;
    // One entry per resource; each `grantId` is a fresh row id (per-resource revoke target).
    rows: Array<{ grantId: string; resource: Resource }>;
  }): Promise<void>;

  /**
   * List an account's ACTIVE (revokedAt IS NULL) first-party agent tokens, GROUPED into grant sets (ROAD-0011
   * P1 §1.4): one entry per `tokenGroupId` carrying its per-resource set. Returns ONLY non-secret metadata —
   * never the tokenHash, never the raw token. Account-scoped on principalId; OAuth-issued grants (clientId set)
   * are excluded (they belong to the Connected-apps surface). A per-resource row that was individually revoked
   * simply drops out of its token's `resources` set; a token with all resources revoked disappears entirely.
   */
  listAgentGrantsForAccount(accountId: string): Promise<
    Array<{
      tokenId: string;
      label: string | null;
      scope: Scope[];
      resources: AgentGrantResourceRow[];
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
   * Whole-token revoke (ROAD-0011 P1 §1.4): revoke EVERY live row of a grant set by its `tokenGroupId`, ONLY
   * when owned by `accountId` (BOLA — the account match is IN the WHERE) and only first-party (clientId IS
   * NULL). Kills all of the token's resources at once (the "revoke this connection" button), as opposed to
   * {@link revokeAgentGrantForAccount} which drops ONE resource. Returns rows affected (0 = not yours / gone).
   */
  revokeAgentTokenGroupForAccount(tokenGroupId: string, accountId: string): Promise<number>;

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

  /**
   * ROAD-0005 P4 denial-of-wallet (Tier 2) — charge ONE unit of `metric` to (accountId, dayBucket) IFF the
   * day's running count is below `cap`. Returns `{ allowed:false, count:cap }` (without charging) once the
   * budget is spent. ATOMIC: a single guarded UPSERT (`ON CONFLICT … WHERE count < cap … RETURNING count`),
   * so the counter is a HARD ceiling that can never exceed `cap` even under a concurrent burst — no
   * read-then-write race. Upsert into `usageCounter` (migration 0016).
   */
  chargeUsage(
    accountId: string,
    metric: string,
    dayBucket: string,
    cap: number,
    updatedAt: string,
  ): Promise<{ allowed: boolean; count: number }>;

  /** Reap `usageCounter` rows whose dayBucket is strictly before `beforeDayBucket` ('YYYY-MM-DD'). */
  pruneUsage(beforeDayBucket: string): Promise<void>;

  /**
   * Reap `auditLog` (the D1 PROJECTION mirror) rows older than `beforeIso`. The append-only AE dataset is
   * the forensic truth and is NEVER pruned — only this readable D1 copy is bounded (retention sweep).
   */
  pruneAuditLog(beforeIso: string): Promise<void>;

  // --- OAuth provider (migration 0017) ------------------------------------------------------------
  // deltos as an OAuth 2.1 Authorization Server for its own MCP resource. See docs/design/oauth-provider.md.
  // The issued access token is inserted via insertAgentGrant({ clientId }) — these methods own only the
  // client registry + the single-use authorization-code lifecycle + the Connected-apps list/revoke/prune.

  /** DCR (RFC 7591): persist a newly registered public client. `redirectUris` is the exact-match allow-list. */
  registerOauthClient(row: {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    softwareId: string | null;
    metadata: string | null; // JSON blob of remaining (non-authoritative) DCR metadata
    createdAt: string; // ISO-8601 Z
  }): Promise<void>;

  /** Resolve a registered client for redirect-uri validation at /authorize + /token. Null if unknown. */
  getOauthClient(
    clientId: string,
  ): Promise<{ clientId: string; clientName: string; redirectUris: string[] } | null>;

  /** Persist a freshly minted authorization code (single-use, short-TTL). Only the hash is stored (F6). */
  insertOauthCode(row: {
    codeHash: string;
    clientId: string;
    accountId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: Scope[];
    resource: string | null; // RFC-8707 audience url (NOT the resource-scope set below)
    // The clamped resource SET the user approved at consent (grant sets, ROAD-0011 P1 §1.3). Carried on the
    // code so /token can mint the matching N-row grant set. Empty/absent ⇒ [{workspace}] at redemption.
    resources: Resource[];
    expiresAtMs: number;
    createdAt: string; // ISO-8601 Z
  }): Promise<void>;

  /**
   * ATOMIC single-use redemption at /token: claim the code IFF it is unconsumed AND unexpired, latching
   * `consumedAt` in the same statement (RETURNING the bound fields). A second concurrent/replayed redemption
   * matches zero rows → null → deny. This is the security-critical latch (mirrors the chargeUsage guard):
   * the single-use property holds even under a concurrent burst because the claim + latch are one UPDATE.
   */
  consumeOauthCode(
    codeHash: string,
    nowMs: number,
  ): Promise<{
    clientId: string;
    accountId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: Scope[];
    resource: string | null;
    resources: Resource[];
  } | null>;

  /**
   * Connected-apps listing: the account's ACTIVE (revokedAt IS NULL) OAuth-issued grants, joined to their
   * client for a display name. Account-scoped on principalId (BOLA). Non-secret metadata only.
   */
  listOauthGrantsForAccount(accountId: string): Promise<
    Array<{
      tokenId: string;
      clientId: string;
      clientName: string | null;
      scope: Scope[];
      resources: AgentGrantResourceRow[];
      createdAt: string;
    }>
  >;

  /**
   * BOLA-CRITICAL per-client revoke: revoke ALL of an account's live OAuth grants for one clientId — BOTH
   * the access grants (principalKind='agent' AND clientId) AND the outstanding refresh tokens (theft can't
   * survive a disconnect). The account match is IN every WHERE, so it can neither touch another account's
   * tokens nor an owner session grant. Returns the ACCESS rows affected (0 = nothing to revoke → 404).
   */
  revokeOauthGrantsForClient(clientId: string, accountId: string): Promise<number>;

  // --- OAuth rotating refresh tokens (migration 0021, oauth-provider.md §5 "v1-rotating") ----------

  /** Persist a freshly minted OAuth refresh token. Only the HASH is stored (F6); carries the re-mint binding. */
  insertOauthRefreshToken(row: {
    tokenHash: string;
    familyId: string;
    clientId: string;
    accountId: string;
    scope: Scope[]; // the clamped consent scope — carried unchanged across every rotation (never widens)
    resources: Resource[]; // the approved resource SET — carried unchanged so rotation re-mints it exactly
    resource: string | null; // RFC-8707 audience url, carried unchanged
    issuedAtMs: number;
    expiresAtMs: number;
  }): Promise<void>;

  /**
   * Resolve an OAuth refresh token by hash REGARDLESS of rotated/revoked/expired state — the route decides
   * (reuse-detection needs to SEE a spent/revoked row to trigger the family-nuke). Null only if no row matches.
   */
  getOauthRefreshToken(tokenHash: string): Promise<{
    familyId: string;
    clientId: string;
    accountId: string;
    scope: Scope[];
    resources: Resource[];
    resource: string | null;
    expiresAtMs: number;
    rotatedAt: string | null;
    revokedAt: string | null;
  } | null>;

  /**
   * ATOMICALLY claim an OAuth refresh token for rotation: latch `rotatedAt` IFF it is still unrotated, in ONE
   * guarded UPDATE (`WHERE tokenHash = ? AND rotatedAt IS NULL`). Returns whether THIS call won the claim —
   * `true` = we latched it (proceed to issue the successor), `false` = it was already rotated out from under us
   * (a concurrent rotation or a replay), so the caller MUST treat it as reuse (family-nuke) and issue nothing.
   * Making the claim atomic is what stops two concurrent refreshes both passing the reuse guard and both minting
   * a successor (which would silently skip theft detection). Test the result as `> 0`, NOT `=== 1`: real D1
   * counts INDEX writes so a single-row UPDATE can report >1 (gotcha d1-rowswritten-index-inflation).
   */
  markOauthRefreshRotated(tokenHash: string, rotatedAt: string): Promise<boolean>;

  /**
   * THEFT-NUKE (reuse-detection): revoke the ENTIRE rotation family — every refresh token AND every
   * outstanding OAuth access grant sharing `familyId` (grants.familyId, 0014) — in ONE batch. Fired when a
   * spent/revoked refresh token is presented again. After this, the family's access token AND refresh both fail.
   */
  revokeOauthRefreshFamily(familyId: string, revokedAt: string): Promise<void>;

  /** Reap authorization codes past their TTL or already consumed (cron retention; the raw code is unrecoverable). */
  pruneOauthCodes(beforeMs: number): Promise<void>;

  /** Reap OAuth refresh tokens past their durable window OR already rotated/revoked (cron retention). */
  pruneOauthRefreshTokens(beforeMs: number): Promise<void>;

  /**
   * Reap registered clients older than `beforeIso` that hold NO live grant — the durable backstop against
   * DCR row-spam (the /register rate-limit fails open). A client with ANY live (revokedAt IS NULL) grant is
   * kept regardless of age; only genuinely-unused clients are dropped.
   */
  pruneOauthClients(beforeIso: string): Promise<void>;
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

/** The column projection every grant-resolve query shares (singular + resolve-all). */
const GRANT_RESOLVE_SQL =
  `SELECT grantId, tokenGroupId, principalKind, principalId, resourceKind, resourceId, scope, expiresAtMs, revokedAt
     FROM grants WHERE tokenHash = ?`;

interface GrantResolveRow {
  grantId: string;
  tokenGroupId: string | null;
  principalKind: string;
  principalId: string;
  resourceKind: string;
  resourceId: string | null;
  scope: string;
  expiresAtMs: number | null;
  revokedAt: string | null;
}

/**
 * Parse a raw grant row to a {@link ResolvedGrantRow}, fail-closed at the DB read boundary: a row that does
 * not parse to a valid principal/resource/scope THROWS here rather than handing a malformed grant to the
 * chokepoint. ⚠ RE-POINT (migration 0003): for owner/device grants `principalId` MEANS `accountId`, NOT a
 * credential fingerprint — so the resolved `principal.id` is the account key the data layer scopes by.
 */
function parseResolvedGrantRow(row: GrantResolveRow): ResolvedGrantRow {
  const principal = PrincipalSchema.parse({ kind: row.principalKind, id: row.principalId });
  const resource = ResourceSchema.parse(
    row.resourceKind === 'workspace'
      ? { kind: 'workspace' }
      : { kind: row.resourceKind, id: row.resourceId },
  );
  const scope = ScopeArraySchema.parse(JSON.parse(row.scope));
  return {
    grantId: row.grantId,
    tokenGroupId: row.tokenGroupId,
    principal,
    resource,
    scope,
    expiresAtMs: row.expiresAtMs,
    revokedAt: row.revokedAt,
  };
}

/** A raw grant row for the grouped token listings (first-party + OAuth share the resource-grouping shape). */
interface AgentGrantListRow {
  grantId: string;
  tokenGroupId: string | null;
  label: string | null;
  scope: string;
  resourceKind: string;
  resourceId: string | null;
  createdAt: string;
  clientId?: string | null;
  clientName?: string | null;
}

/** Map a stored resourceKind string to the token-view kind (fail-safe to 'workspace' on anything unexpected). */
function toResourceKind(k: string): AgentGrantResourceRow['kind'] {
  return k === 'notebook' ? 'notebook' : k === 'note' ? 'note' : 'workspace';
}

interface GroupedToken {
  tokenId: string;
  label: string | null;
  scope: Scope[];
  resources: AgentGrantResourceRow[];
  createdAt: string;
  clientId: string | null;
  clientName: string | null;
}

/**
 * Group per-resource grant rows into logical TOKENS by `tokenGroupId` (grant sets, ROAD-0011 P1). A row with a
 * NULL group (pre-grant-set / single-resource legacy) is its own token, keyed by its grantId. Rows arrive
 * ordered (createdAt, grantId); groups keep first-seen order + the group's earliest createdAt. Scope/label/
 * client are uniform within a group (one mint event), so the first row's values represent the token.
 */
function groupGrantRowsIntoTokens(rows: AgentGrantListRow[]): GroupedToken[] {
  const byToken = new Map<string, GroupedToken>();
  const order: string[] = [];
  for (const r of rows) {
    const tokenId = r.tokenGroupId ?? r.grantId;
    let t = byToken.get(tokenId);
    if (!t) {
      t = {
        tokenId,
        label: r.label,
        // Parse + re-validate the stored scope at this read boundary (fail-closed on a malformed row).
        scope: ScopeArraySchema.parse(JSON.parse(r.scope)),
        resources: [],
        createdAt: r.createdAt,
        clientId: r.clientId ?? null,
        clientName: r.clientName ?? null,
      };
      byToken.set(tokenId, t);
      order.push(tokenId);
    }
    t.resources.push({ grantId: r.grantId, kind: toResourceKind(r.resourceKind), id: r.resourceId });
  }
  return order.map((id) => byToken.get(id)!);
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
      const row = await db.first<GrantResolveRow>(GRANT_RESOLVE_SQL, [tokenHash]);
      return row ? parseResolvedGrantRow(row) : null;
    },

    async resolveGrantsByTokenHash(tokenHash) {
      // Grant SETS: a token hash can map to N rows (one per resource). Order is stable (createdAt, grantId)
      // so the any-of iteration + the representative pick are deterministic.
      const rows = await db.all<GrantResolveRow>(
        `${GRANT_RESOLVE_SQL} ORDER BY createdAt, grantId`,
        [tokenHash],
      );
      return rows.map(parseResolvedGrantRow);
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
          // tokenGroupId = the row's own grantId: a single-resource token is its own group, so the
          // grouped listing yields exactly one token for it (grant sets, ROAD-0011 P1).
          sql: `INSERT INTO grants
                  (grantId, tokenHash, tokenGroupId, principalKind, principalId, mintedByKeyId,
                   resourceKind, resourceId, scope, expiresAtMs, revokedAt, createdAt, label, clientId)
                VALUES (?, ?, ?, 'agent', ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
          params: [
            row.grantId,
            row.tokenHash,
            row.grantId, // tokenGroupId = self
            row.accountId, // principalId = OWNER accountId (server-derived; reads scope to this account)
            row.resource.kind,
            resourceId,
            JSON.stringify(row.scope), // already CLAMPED read-only at the route
            row.createdAt,
            row.label,
            row.clientId ?? null, // OAuth-issued → registered clientId; first-party → null
          ],
        },
      ]);
    },

    async insertAgentGrantSet(row) {
      // ONE batch = ONE atomic mint: N rows, all sharing tokenHash + tokenGroupId + scope + createdAt, one
      // per resource. tokenHash being shared is why 0002's UNIQUE(tokenHash) was dropped (migration 0020).
      const scopeJson = JSON.stringify(row.scope);
      const clientId = row.clientId ?? null;
      const expiresAtMs = row.expiresAtMs ?? null; // NULL = non-expiring (first-party); OAuth passes a 1h TTL
      const familyId = row.familyId ?? null; // links OAuth access grants to their rotation family (0014)
      await db.batch(
        row.rows.map((r) => ({
          sql: `INSERT INTO grants
                  (grantId, tokenHash, tokenGroupId, principalKind, principalId, mintedByKeyId,
                   resourceKind, resourceId, scope, expiresAtMs, revokedAt, createdAt, label, clientId, familyId)
                VALUES (?, ?, ?, 'agent', ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
          params: [
            r.grantId,
            row.tokenHash,
            row.tokenGroupId,
            row.accountId,
            r.resource.kind,
            r.resource.kind === 'workspace' ? null : r.resource.id,
            scopeJson,
            expiresAtMs,
            row.createdAt,
            row.label,
            clientId,
            familyId,
          ],
        })),
      );
    },

    async listAgentGrantsForAccount(accountId) {
      const rows = await db.all<AgentGrantListRow>(
        // clientId IS NULL keeps this the FIRST-PARTY agent-token list only — OAuth-issued grants (clientId
        // set) belong to the Connected-apps surface (listOauthGrantsForAccount), never the Settings token list.
        `SELECT grantId, tokenGroupId, label, scope, resourceKind, resourceId, createdAt
           FROM grants
          WHERE principalKind = 'agent' AND principalId = ? AND clientId IS NULL AND revokedAt IS NULL
          ORDER BY createdAt, grantId`,
        [accountId],
      );
      return groupGrantRowsIntoTokens(rows).map((t) => ({
        tokenId: t.tokenId,
        label: t.label,
        scope: t.scope,
        resources: t.resources,
        createdAt: t.createdAt,
      }));
    },

    async revokeAgentGrantForAccount(grantId, accountId) {
      // The account match is IN the WHERE — a row owned by another account matches zero rows (BOLA). Scoped
      // to principalKind='agent' so it can never revoke an owner session grant. Idempotent re-revoke = 0 rows.
      const now = new Date().toISOString();
      const [res] = await db.batch([
        {
          sql: `UPDATE grants SET revokedAt = ?
                 WHERE grantId = ? AND principalKind = 'agent' AND principalId = ? AND clientId IS NULL AND revokedAt IS NULL`,
          params: [now, grantId, accountId],
        },
      ]);
      return res?.rowsWritten ?? 0;
    },

    async revokeAgentTokenGroupForAccount(tokenGroupId, accountId) {
      // Whole-token revoke: every live row of the set, BOLA-scoped (account match IN the WHERE) + first-party
      // (clientId IS NULL). rowsWritten counts INDEX writes on real D1 — treat >0 as revoked, never === N.
      const now = new Date().toISOString();
      const [res] = await db.batch([
        {
          sql: `UPDATE grants SET revokedAt = ?
                 WHERE tokenGroupId = ? AND principalKind = 'agent' AND principalId = ? AND clientId IS NULL AND revokedAt IS NULL`,
          params: [now, tokenGroupId, accountId],
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
      // ALSO nuke this account's OAuth refresh tokens (migration 0021) in the same batch: revoke-all is the
      // "I think I'm compromised" action, so a rotating refresh must die with the access grants it re-mints —
      // otherwise a stolen refresh would silently re-issue access right past the sweep meant to end it.
      await db.batch([
        {
          sql: `UPDATE grants SET revokedAt = ?
                 WHERE principalKind IN ('owner', 'agent') AND principalId = ? AND revokedAt IS NULL`,
          params: [revokedAt, accountId],
        },
        {
          sql: `UPDATE oauthRefreshToken SET revokedAt = ?
                 WHERE accountId = ? AND revokedAt IS NULL`,
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

    async chargeUsage(accountId, metric, dayBucket, cap, updatedAt) {
      // ATOMIC charge in a SINGLE statement so the cap is a HARD ceiling even under a concurrent burst
      // (no read-then-write race): the ON CONFLICT guard `WHERE count < cap` makes the increment a no-op
      // once the cap is reached, so the counter can never exceed `cap`. RETURNING yields the post-charge
      // count on a successful charge; when the guard blocks an at-cap row, the UPSERT touches nothing and
      // RETURNING produces NO row — that absence IS the deny signal. (A brand-new row is always inserted
      // at count=1; safe because every `cap` is >= 1.) `count >= cap` semantics: exactly `cap` charges
      // succeed per (account, metric, day).
      const row = await db.first<{ count: number }>(
        `INSERT INTO usageCounter (accountId, metric, dayBucket, count, updatedAt)
              VALUES (?, ?, ?, 1, ?)
              ON CONFLICT(accountId, metric, dayBucket) DO UPDATE SET
                count = count + 1,
                updatedAt = excluded.updatedAt
              WHERE count < ?
         RETURNING count`,
        [accountId, metric, dayBucket, updatedAt, cap],
      );
      if (row) return { allowed: true, count: row.count };
      return { allowed: false, count: cap };
    },

    async pruneUsage(beforeDayBucket) {
      await db.batch([
        { sql: `DELETE FROM usageCounter WHERE dayBucket < ?`, params: [beforeDayBucket] },
      ]);
    },

    async pruneAuditLog(beforeIso) {
      await db.batch([{ sql: `DELETE FROM auditLog WHERE ts < ?`, params: [beforeIso] }]);
    },

    // --- OAuth provider (migration 0017) ----------------------------------------------------------

    async registerOauthClient(row) {
      await db.batch([
        {
          sql: `INSERT INTO oauthClient (clientId, clientName, redirectUris, softwareId, metadata, createdAt)
                VALUES (?, ?, ?, ?, ?, ?)`,
          params: [
            row.clientId,
            row.clientName,
            JSON.stringify(row.redirectUris),
            row.softwareId,
            row.metadata,
            row.createdAt,
          ],
        },
      ]);
    },

    async getOauthClient(clientId) {
      const r = await db.first<{ clientId: string; clientName: string; redirectUris: string }>(
        `SELECT clientId, clientName, redirectUris FROM oauthClient WHERE clientId = ?`,
        [clientId],
      );
      if (!r) return null;
      // Parse + re-validate the stored allow-list at this read boundary (fail-closed on a malformed row).
      const redirectUris = z.array(z.string()).parse(JSON.parse(r.redirectUris));
      return { clientId: r.clientId, clientName: r.clientName, redirectUris };
    },

    async insertOauthCode(row) {
      await db.batch([
        {
          sql: `INSERT INTO oauthAuthCode
                  (codeHash, clientId, accountId, redirectUri, codeChallenge, scope, resource, resources,
                   expiresAtMs, consumedAt, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          params: [
            row.codeHash,
            row.clientId,
            row.accountId,
            row.redirectUri,
            row.codeChallenge,
            JSON.stringify(row.scope),
            row.resource,
            JSON.stringify(row.resources),
            row.expiresAtMs,
            row.createdAt,
          ],
        },
      ]);
    },

    async consumeOauthCode(codeHash, nowMs) {
      // ATOMIC single-use claim: the WHERE selects only an unconsumed, unexpired code and the SET latches
      // consumedAt in the SAME statement, so a replay/concurrent redemption matches zero rows (no
      // read-then-write window). RETURNING yields the bound fields exactly once; absence = deny.
      const consumedAt = new Date(nowMs).toISOString();
      const r = await db.first<{
        clientId: string;
        accountId: string;
        redirectUri: string;
        codeChallenge: string;
        scope: string;
        resource: string | null;
        resources: string | null;
      }>(
        `UPDATE oauthAuthCode SET consumedAt = ?
          WHERE codeHash = ? AND consumedAt IS NULL AND expiresAtMs > ?
        RETURNING clientId, accountId, redirectUri, codeChallenge, scope, resource, resources`,
        [consumedAt, codeHash, nowMs],
      );
      if (!r) return null;
      return {
        clientId: r.clientId,
        accountId: r.accountId,
        redirectUri: r.redirectUri,
        codeChallenge: r.codeChallenge,
        scope: ScopeArraySchema.parse(JSON.parse(r.scope)), // fail-closed re-validate at the boundary
        resource: r.resource,
        // Resource SET carried from consent (grant sets). Absent/legacy codes ⇒ workspace (backward-safe).
        resources: r.resources ? ResourceArraySchema.parse(JSON.parse(r.resources)) : [{ kind: 'workspace' }],
      };
    },

    async listOauthGrantsForAccount(accountId) {
      const rows = await db.all<AgentGrantListRow>(
        `SELECT g.grantId, g.tokenGroupId, g.label, g.scope, g.resourceKind, g.resourceId, g.createdAt,
                g.clientId, c.clientName
           FROM grants g
           LEFT JOIN oauthClient c ON c.clientId = g.clientId
          WHERE g.principalKind = 'agent' AND g.principalId = ? AND g.clientId IS NOT NULL
                AND g.revokedAt IS NULL
          ORDER BY g.createdAt, g.grantId`,
        [accountId],
      );
      return groupGrantRowsIntoTokens(rows).map((t) => ({
        tokenId: t.tokenId,
        clientId: t.clientId ?? '',
        clientName: t.clientName,
        scope: t.scope,
        resources: t.resources,
        createdAt: t.createdAt,
      }));
    },

    async revokeOauthGrantsForClient(clientId, accountId) {
      // BOLA + scope belt IN the WHERE: only this account's live agent grants for this clientId. Cannot
      // reach another account's rows or an owner session grant. Idempotent re-revoke = 0 rows. The route
      // treats the result as >0 (revoked) vs 0 (nothing/not-yours → 404): real D1 `rowsWritten` counts
      // INDEX writes (grants_byClientId + others), so it is NOT a reliable grant CARDINALITY — never test ===.
      // The SECOND statement kills the client's outstanding refresh tokens for this account (migration 0021)
      // in the same batch — a disconnect must revoke BOTH access AND refresh, or the app reconnects silently.
      const now = new Date().toISOString();
      const [res] = await db.batch([
        {
          sql: `UPDATE grants SET revokedAt = ?
                 WHERE principalKind = 'agent' AND principalId = ? AND clientId = ? AND revokedAt IS NULL`,
          params: [now, accountId, clientId],
        },
        {
          sql: `UPDATE oauthRefreshToken SET revokedAt = ?
                 WHERE accountId = ? AND clientId = ? AND revokedAt IS NULL`,
          params: [now, accountId, clientId],
        },
      ]);
      // The ACCESS-grant UPDATE (res[0]) is the 404 signal — a client with only stale/rotated refresh rows and
      // no live access grant is already effectively disconnected.
      return res?.rowsWritten ?? 0;
    },

    async insertOauthRefreshToken(row) {
      await db.batch([
        {
          sql: `INSERT INTO oauthRefreshToken
                  (tokenHash, familyId, clientId, accountId, scope, resources, resource,
                   issuedAtMs, expiresAtMs, rotatedAt, revokedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
          params: [
            row.tokenHash,
            row.familyId,
            row.clientId,
            row.accountId,
            JSON.stringify(row.scope),
            JSON.stringify(row.resources),
            row.resource,
            row.issuedAtMs,
            row.expiresAtMs,
          ],
        },
      ]);
    },

    async getOauthRefreshToken(tokenHash) {
      const r = await db.first<{
        familyId: string;
        clientId: string;
        accountId: string;
        scope: string;
        resources: string;
        resource: string | null;
        expiresAtMs: number;
        rotatedAt: string | null;
        revokedAt: string | null;
      }>(
        `SELECT familyId, clientId, accountId, scope, resources, resource, expiresAtMs, rotatedAt, revokedAt
           FROM oauthRefreshToken WHERE tokenHash = ?`,
        [tokenHash],
      );
      if (!r) return null;
      // Fail-closed re-validate at the boundary: a malformed persisted scope/resources row resolves to null
      // (the route maps null → invalid_grant) rather than throwing a 500 — a corrupt row denies, never crashes.
      try {
        return {
          familyId: r.familyId,
          clientId: r.clientId,
          accountId: r.accountId,
          scope: ScopeArraySchema.parse(JSON.parse(r.scope)),
          resources: ResourceArraySchema.parse(JSON.parse(r.resources)),
          resource: r.resource,
          expiresAtMs: r.expiresAtMs,
          rotatedAt: r.rotatedAt,
          revokedAt: r.revokedAt,
        };
      } catch {
        return null;
      }
    },

    async markOauthRefreshRotated(tokenHash, rotatedAt) {
      // ATOMIC claim: the `rotatedAt IS NULL` guard makes this the single authority on "did I win the rotation".
      // rowsWritten > 0 = we latched it; 0 = already rotated (concurrent/replay) → caller nukes the family.
      // Test > 0, NOT === 1 — real D1 counts INDEX writes (gotcha d1-rowswritten-index-inflation).
      const [res] = await db.batch([
        {
          sql: `UPDATE oauthRefreshToken SET rotatedAt = ? WHERE tokenHash = ? AND rotatedAt IS NULL`,
          params: [rotatedAt, tokenHash],
        },
      ]);
      return (res?.rowsWritten ?? 0) > 0;
    },

    async revokeOauthRefreshFamily(familyId, revokedAt) {
      // ONE batch = ONE transaction: kill every refresh row in the family AND every outstanding OAuth access
      // grant linked to it (grants.familyId, 0014). This is the theft-nuke — after it, the family's access
      // token AND refresh both fail. Idempotent (revokedAt IS NULL guards re-revoke).
      await db.batch([
        {
          sql: `UPDATE oauthRefreshToken SET revokedAt = ? WHERE familyId = ? AND revokedAt IS NULL`,
          params: [revokedAt, familyId],
        },
        {
          sql: `UPDATE grants SET revokedAt = ?
                 WHERE familyId = ? AND principalKind = 'agent' AND revokedAt IS NULL`,
          params: [revokedAt, familyId],
        },
      ]);
    },

    async pruneOauthCodes(beforeMs) {
      // Reap anything past TTL or already consumed; the 60s TTL means this is a trickle regardless.
      await db.batch([
        {
          sql: `DELETE FROM oauthAuthCode WHERE expiresAtMs < ? OR consumedAt IS NOT NULL`,
          params: [beforeMs],
        },
      ]);
    },

    async pruneOauthRefreshTokens(beforeMs) {
      // Reap refresh tokens past their durable window OR already spent (rotated) OR revoked — the live HEAD of
      // an active family (unrotated, unrevoked, unexpired) is always kept, so a connected app is never orphaned.
      await db.batch([
        {
          sql: `DELETE FROM oauthRefreshToken
                 WHERE expiresAtMs < ? OR rotatedAt IS NOT NULL OR revokedAt IS NOT NULL`,
          params: [beforeMs],
        },
      ]);
    },

    async pruneOauthClients(beforeIso) {
      // Drop old clients that hold no LIVE grant. The NOT IN sub-select keeps any client with an active
      // OAuth grant (so a connected app is never orphaned); only stale/unused registrations are reaped.
      await db.batch([
        {
          sql: `DELETE FROM oauthClient
                 WHERE createdAt < ?
                   AND clientId NOT IN (
                     SELECT clientId FROM grants WHERE clientId IS NOT NULL AND revokedAt IS NULL
                   )`,
          params: [beforeIso],
        },
      ]);
    },
  };
}
