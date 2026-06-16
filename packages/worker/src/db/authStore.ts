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
  };
}
