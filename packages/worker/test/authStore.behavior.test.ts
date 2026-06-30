/**
 * authStore ADVERSARIAL layer — secSys acceptance gate.
 *
 * These tests sit BEYOND devSys2's 14 correctness cases in authStore.test.ts.
 * Each targets a SECURITY INVARIANT that must hold even under adversarial input:
 * - consumeChallenge CAS boundary at exact expiry (> not >=)
 * - replay race: consumed challenge returns null on repeat
 * - concurrent double-consume: exactly one of N simultaneous consumes succeeds (atomic single-use)
 * - registry UNIQUE-PK enforcement (duplicate keyId throws)
 * - multiple devices with the same signingPublicKey are permitted (no spurious UNIQUE)
 * - getDevice does NOT hide revoked rows — callers check revokedAt
 * - mintGrant duplicate tokenHash rejected (UNIQUE — F6 uniqueness)
 * - resolveGrantByTokenHash returns revoked + expired rows (chokepoint decides, not this layer)
 * - fail-closed read: corrupted scope JSON or principalKind throws rather than silently passing
 * - non-owner principalKind (agent) round-trips through mint → resolve (kind column not assumed owner)
 * - revokeByKeyId scope: capability grants (mintedByKeyId=null) and OTHER devices' grants untouched
 * - revokeByKeyId unknown keyId: no-op, no throw
 * - revokeGrant idempotency: second call preserves the first revokedAt
 * - sweepExpiredChallenges boundary: exactly-at-boundary (expiresAtMs===serverNowMs) is NOT swept
 * - deviceSigningPublicKey D5 seam: NOT NULL, stores the supplied key (v1=signingPublicKey, Phase-2=device key); NULL rejected
 * - schema CHECK constraints reject out-of-set purpose / consumed at the DB boundary (finding 4)
 *
 * DO NOT duplicate devSys2's cases.  Imports and adapter are intentionally identical so the
 * harness is self-contained (no shared fixture module to coordinate).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PrincipalSchema, ResourceSchema, ScopeSchema, type Scope } from '@deltos/shared';
import type { DbAdapter } from '../src/db/schema.js';
import { createAuthStore } from '../src/db/authStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const migrations = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0013_agent-token-label.sql', // grants.label — required by insertAgentGrant (standalone ADD COLUMN)
  '0014_grant-family-link.sql', // adds grants.familyId (the mintGrant INSERT lists it) — ALTER works on the 0002 table
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function sqliteAdapter(db: Database.Database): DbAdapter {
  return {
    async batch(stmts) {
      const results: { rowsWritten: number }[] = [];
      const txn = db.transaction(() => {
        for (const s of stmts) {
          const info = db.prepare(s.sql).run(...(s.params as Array<string | number | null>));
          results.push({ rowsWritten: info.changes });
        }
      });
      txn();
      return results;
    },
    async first<T>(sql: string, params: unknown[]) {
      const row = db.prepare(sql).get(...(params as Array<string | number | null>));
      return (row ?? null) as T | null;
    },
    async all<T>(sql: string, params: unknown[]) {
      return db.prepare(sql).all(...(params as Array<string | number | null>)) as T[];
    },
  };
}

function freshStoreWithRaw() {
  const raw = new Database(':memory:');
  for (const migration of migrations) raw.exec(migration);
  return { store: createAuthStore(sqliteAdapter(raw)), raw };
}

// Helpers mirroring devSys2 conventions for consistency.
const owner = (id: string) => PrincipalSchema.parse({ kind: 'owner', id });
const noteResource = (id: string) => ResourceSchema.parse({ kind: 'note', id });
const workspaceResource = () => ResourceSchema.parse({ kind: 'workspace' });
const scopes = (...s: string[]) => s.map((x) => ScopeSchema.parse(x)) as Scope[];

const FP_A = 'fingerprint-aaa';
const FP_B = 'fingerprint-bbb';
const FUTURE = 9_999_999_999_999; // epoch-ms far in the future
const NOTE_UUID = '00000000-0000-4000-8000-aaaaaaaaaaaa';

let store: ReturnType<typeof createAuthStore>;
let raw: Database.Database;

beforeEach(() => {
  const pair = freshStoreWithRaw();
  store = pair.store;
  raw = pair.raw;
});

// ---------------------------------------------------------------------------
// consumeChallenge adversarial boundary
// ---------------------------------------------------------------------------

describe('consumeChallenge — adversarial boundary (secSys)', () => {
  it('exactly-at-expiry (expiresAtMs === serverNowMs) is rejected — the gate is >, not >= (AUTH-PROP-2 boundary)', async () => {
    const NOW = 5000;
    await store.createChallenge({
      challengeId: 'c-boundary', nonce: 'n1', keyId: 'k1',
      purpose: 'session', issuedAt: '2025-01-01T00:00:00Z', expiresAtMs: NOW,
    });
    // expiresAtMs=NOW, serverNowMs=NOW → NOT fresh (requires expiresAtMs > serverNowMs)
    const result = await store.consumeChallenge('c-boundary', 'session', NOW);
    expect(result).toBeNull();
  });

  it('one-millisecond before expiry is accepted, one-millisecond past is rejected (boundary straddle)', async () => {
    const EXPIRY = 5000;
    await store.createChallenge({
      challengeId: 'c-before', nonce: 'n-before', keyId: 'k1',
      purpose: 'session', issuedAt: '2025-01-01T00:00:00Z', expiresAtMs: EXPIRY,
    });
    await store.createChallenge({
      challengeId: 'c-after', nonce: 'n-after', keyId: 'k1',
      purpose: 'session', issuedAt: '2025-01-01T00:00:00Z', expiresAtMs: EXPIRY,
    });
    // one ms before: accepted
    const ok = await store.consumeChallenge('c-before', 'session', EXPIRY - 1);
    expect(ok).not.toBeNull();
    expect(ok!.nonce).toBe('n-before');
    // one ms after: rejected (stale)
    const bad = await store.consumeChallenge('c-after', 'session', EXPIRY + 1);
    expect(bad).toBeNull();
  });

  it('second consume of an already-consumed challenge returns null — explicit replay simulation', async () => {
    await store.createChallenge({
      challengeId: 'c-replay', nonce: 'replay-nonce', keyId: 'k1',
      purpose: 'session', issuedAt: '2025-01-01T00:00:00Z', expiresAtMs: FUTURE,
    });
    const first = await store.consumeChallenge('c-replay', 'session', 0);
    expect(first).not.toBeNull();
    const second = await store.consumeChallenge('c-replay', 'session', 0);
    expect(second).toBeNull();
  });

  it('concurrent double-consume: across N simultaneous consumes of one challenge, EXACTLY one succeeds', async () => {
    await store.createChallenge({
      challengeId: 'c-race', nonce: 'race-nonce', keyId: 'k1',
      purpose: 'session', issuedAt: '2025-01-01T00:00:00Z', expiresAtMs: FUTURE,
    });
    // Single-use lives ENTIRELY in the atomic conditional write (consumed=0 → rows-affected), so even
    // with no ordering guarantee across these calls exactly one wins and the rest get null. A
    // read-then-check (SELECT consumed → UPDATE) would let two of these through — the bug this forecloses.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.consumeChallenge('c-race', 'session', 0)),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(7);
  });

  it('AUTH-1: expiresAtMs=9 consumed at serverNowMs=100 is REJECTED — proves INTEGER, not lexical, compare', async () => {
    await store.createChallenge({
      challengeId: 'c-int-defends', nonce: 'n', keyId: 'k1',
      purpose: 'session', issuedAt: '2025-01-01T00:00:00Z', expiresAtMs: 9,
    });
    // 9 > 100 is FALSE for integers → reject (correct: stale). A TEXT expiresAt would compare '9' > '100'
    // LEXICALLY = TRUE ('9' > '1') and WRONGLY accept this stale challenge. This is THE vector proving the
    // epoch-millis INTEGER column defends AUTH-1 freshness at the storage layer.
    expect(await store.consumeChallenge('c-int-defends', 'session', 100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// registerDevice / getDevice adversarial
// ---------------------------------------------------------------------------

describe('registerDevice / getDevice — adversarial (secSys)', () => {
  it('duplicate keyId → throws UNIQUE PRIMARY KEY constraint (registry integrity)', async () => {
    await store.registerDevice({
      keyId: 'k-dupe', signingPublicKey: 'pubkey-A', deviceSigningPublicKey: 'pubkey-A', accountFingerprint: FP_A,
      deviceLabel: 'First', createdAt: '2025-01-01T00:00:00Z',
    });
    await expect(
      store.registerDevice({
        keyId: 'k-dupe', signingPublicKey: 'pubkey-B', deviceSigningPublicKey: 'pubkey-B', accountFingerprint: FP_A,
        deviceLabel: 'Second', createdAt: '2025-01-01T00:00:01Z',
      }),
    ).rejects.toThrow();
  });

  it('two devices sharing the same signingPublicKey under different keyIds are both stored (v1 multi-device model)', async () => {
    const sharedPubkey = 'shared-pubkey';
    await store.registerDevice({
      keyId: 'k-dev1', signingPublicKey: sharedPubkey, deviceSigningPublicKey: sharedPubkey, accountFingerprint: FP_A,
      deviceLabel: 'Device 1', createdAt: '2025-01-01T00:00:00Z',
    });
    await store.registerDevice({
      keyId: 'k-dev2', signingPublicKey: sharedPubkey, deviceSigningPublicKey: sharedPubkey, accountFingerprint: FP_A,
      deviceLabel: 'Device 2', createdAt: '2025-01-01T00:00:01Z',
    });
    const d1 = await store.getDevice('k-dev1');
    const d2 = await store.getDevice('k-dev2');
    expect(d1).not.toBeNull();
    expect(d2).not.toBeNull();
    expect(d1!.signingPublicKey).toBe(sharedPubkey);
    expect(d2!.signingPublicKey).toBe(sharedPubkey);
  });

  it('getDevice returns the row for a revoked device — revokedAt IS NOT NULL; caller decides the deny', async () => {
    await store.registerDevice({
      keyId: 'k-tobe-revoked', signingPublicKey: 'pk-rev', deviceSigningPublicKey: 'pk-rev', accountFingerprint: FP_A,
      deviceLabel: 'To revoke', createdAt: '2025-01-01T00:00:00Z',
    });
    await store.revokeByKeyId('k-tobe-revoked');
    const device = await store.getDevice('k-tobe-revoked');
    expect(device).not.toBeNull();
    expect(device!.revokedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mintGrant / resolveGrantByTokenHash adversarial
// ---------------------------------------------------------------------------

describe('mintGrant / resolveGrantByTokenHash — adversarial (secSys)', () => {
  it('duplicate tokenHash → throws UNIQUE constraint (F6 uniqueness)', async () => {
    await store.mintGrant({
      grantId: 'g1', tokenHash: 'h-clash',
      principal: owner(FP_A), mintedByKeyId: 'k1',
      resource: workspaceResource(), scope: scopes('read'),
      expiresAtMs: null, createdAt: '2025-01-01T00:00:00Z',
    });
    await expect(
      store.mintGrant({
        grantId: 'g2', tokenHash: 'h-clash',
        principal: owner(FP_A), mintedByKeyId: 'k2',
        resource: workspaceResource(), scope: scopes('read'),
        expiresAtMs: null, createdAt: '2025-01-01T00:00:01Z',
      }),
    ).rejects.toThrow();
  });

  it('revoked grant is still returned by resolveGrantByTokenHash — the layer never hides; chokepoint decides', async () => {
    await store.mintGrant({
      grantId: 'g-rev', tokenHash: 'h-rev',
      principal: owner(FP_A), mintedByKeyId: 'k1',
      resource: workspaceResource(), scope: scopes('read'),
      expiresAtMs: null, createdAt: '2025-01-01T00:00:00Z',
    });
    await store.revokeGrant('g-rev');
    const resolved = await store.resolveGrantByTokenHash('h-rev');
    expect(resolved).not.toBeNull();
    expect(resolved!.revokedAt).not.toBeNull();
  });

  it('expired grant (expiresAtMs in the past) is still returned — layer does not enforce expiry (chokepoint does)', async () => {
    await store.mintGrant({
      grantId: 'g-exp', tokenHash: 'h-exp',
      principal: owner(FP_A), mintedByKeyId: 'k1',
      resource: workspaceResource(), scope: scopes('read'),
      expiresAtMs: 1, // epoch-ms 1 = far in the past
      createdAt: '2025-01-01T00:00:00Z',
    });
    const resolved = await store.resolveGrantByTokenHash('h-exp');
    expect(resolved).not.toBeNull();
    expect(resolved!.expiresAtMs).toBe(1);
  });

  // H3 (ROAD-0005 P0): revoke-all must kill AGENT tokens too (non-expiring → revocation is the ONLY
  // control), not just owner sessions — and must stay account-scoped (another account is untouched).
  it('revokeGrantsByAccount sweeps agent grants AND owner sessions for the account, but NOT another account', async () => {
    await store.mintGrant({
      grantId: 'g-owner-a', tokenHash: 'h-owner-a',
      principal: owner(FP_A), mintedByKeyId: 'k1',
      resource: workspaceResource(), scope: scopes('read'),
      expiresAtMs: null, createdAt: '2025-01-01T00:00:00Z',
    });
    await store.insertAgentGrant({
      grantId: 'g-agent-a', tokenHash: 'h-agent-a', accountId: FP_A, label: null,
      resource: workspaceResource(), scope: scopes('read'), createdAt: '2025-01-01T00:00:00Z',
    });
    await store.insertAgentGrant({
      grantId: 'g-agent-b', tokenHash: 'h-agent-b', accountId: FP_B, label: null,
      resource: workspaceResource(), scope: scopes('read'), createdAt: '2025-01-01T00:00:00Z',
    });

    await store.revokeGrantsByAccount(FP_A, '2025-06-01T00:00:00Z');

    // FP_A's owner session AND agent token are both revoked (the H3 fix)...
    expect((await store.resolveGrantByTokenHash('h-owner-a'))!.revokedAt).not.toBeNull();
    expect((await store.resolveGrantByTokenHash('h-agent-a'))!.revokedAt).not.toBeNull();
    // ...but FP_B's agent token is untouched — the sweep is account-scoped, not global.
    expect((await store.resolveGrantByTokenHash('h-agent-b'))!.revokedAt).toBeNull();
  });

  it('corrupted scope JSON in DB → resolveGrantByTokenHash throws fail-closed rather than returning garbage', async () => {
    // Insert a row with broken scope JSON directly, bypassing the store's mintGrant.
    raw.exec(`
      INSERT INTO grants (grantId, tokenHash, principalKind, principalId, mintedByKeyId,
                          resourceKind, resourceId, scope, expiresAtMs, revokedAt, createdAt)
      VALUES ('g-bad-scope', 'h-bad-scope', 'owner', '${FP_A}', NULL,
              'workspace', NULL, 'NOT_VALID_JSON', NULL, NULL, '2025-01-01T00:00:00Z')
    `);
    await expect(store.resolveGrantByTokenHash('h-bad-scope')).rejects.toThrow();
  });

  it('corrupted principalKind in DB → resolveGrantByTokenHash throws (PrincipalSchema.parse fail-closed)', async () => {
    raw.exec(`
      INSERT INTO grants (grantId, tokenHash, principalKind, principalId, mintedByKeyId,
                          resourceKind, resourceId, scope, expiresAtMs, revokedAt, createdAt)
      VALUES ('g-bad-principal', 'h-bad-principal', 'not-a-valid-kind', '${FP_A}', NULL,
              'workspace', NULL, '["read"]', NULL, NULL, '2025-01-01T00:00:00Z')
    `);
    await expect(store.resolveGrantByTokenHash('h-bad-principal')).rejects.toThrow();
  });

  it('corrupted resourceKind in DB → resolveGrantByTokenHash throws (ResourceSchema.parse fail-closed)', async () => {
    raw.exec(`
      INSERT INTO grants (grantId, tokenHash, principalKind, principalId, mintedByKeyId,
                          resourceKind, resourceId, scope, expiresAtMs, revokedAt, createdAt)
      VALUES ('g-bad-resource', 'h-bad-resource', 'owner', '${FP_A}', NULL,
              'not-a-resource-kind', NULL, '["read"]', NULL, NULL, '2025-01-01T00:00:00Z')
    `);
    await expect(store.resolveGrantByTokenHash('h-bad-resource')).rejects.toThrow();
  });

  it('round-trips a non-owner principalKind (agent) through mint → resolve — the kind column is not assumed owner', async () => {
    await store.mintGrant({
      grantId: 'g-agent', tokenHash: 'h-agent',
      principal: PrincipalSchema.parse({ kind: 'agent', id: 'agent-7' }), mintedByKeyId: null,
      resource: noteResource(NOTE_UUID), scope: scopes('read', 'search'),
      expiresAtMs: null, createdAt: '2025-01-01T00:00:00Z',
    });
    const resolved = await store.resolveGrantByTokenHash('h-agent');
    expect(resolved!.principal).toEqual({ kind: 'agent', id: 'agent-7' });
    expect(resolved!.scope).toEqual(['read', 'search']);
  });
});

// ---------------------------------------------------------------------------
// revokeByKeyId scoping adversarial
// ---------------------------------------------------------------------------

describe('revokeByKeyId — scope adversarial (secSys)', () => {
  async function seedTwoDevicesAndGrants() {
    await store.registerDevice({
      keyId: 'k-alpha', signingPublicKey: 'pk-alpha', deviceSigningPublicKey: 'pk-alpha', accountFingerprint: FP_A,
      deviceLabel: 'Alpha', createdAt: '2025-01-01T00:00:00Z',
    });
    await store.registerDevice({
      keyId: 'k-beta', signingPublicKey: 'pk-beta', deviceSigningPublicKey: 'pk-beta', accountFingerprint: FP_A,
      deviceLabel: 'Beta', createdAt: '2025-01-01T00:00:01Z',
    });
    await store.mintGrant({
      grantId: 'g-alpha', tokenHash: 'h-alpha',
      principal: owner(FP_A), mintedByKeyId: 'k-alpha',
      resource: workspaceResource(), scope: scopes('read'),
      expiresAtMs: null, createdAt: '2025-01-01T00:00:00Z',
    });
    await store.mintGrant({
      grantId: 'g-beta', tokenHash: 'h-beta',
      principal: owner(FP_A), mintedByKeyId: 'k-beta',
      resource: workspaceResource(), scope: scopes('read'),
      expiresAtMs: null, createdAt: '2025-01-01T00:00:01Z',
    });
    await store.mintGrant({
      grantId: 'g-capability', tokenHash: 'h-capability',
      principal: owner(FP_B), mintedByKeyId: null, // capability grant — no device
      resource: noteResource(NOTE_UUID), scope: scopes('read'),
      expiresAtMs: null, createdAt: '2025-01-01T00:00:02Z',
    });
  }

  it("revoking k-alpha sweeps k-alpha's grant but leaves k-beta's grant and capability grant intact (PIN-ID-5 scope)", async () => {
    await seedTwoDevicesAndGrants();
    await store.revokeByKeyId('k-alpha');

    const alphaGrant = await store.resolveGrantByTokenHash('h-alpha');
    expect(alphaGrant!.revokedAt).not.toBeNull();

    const betaGrant = await store.resolveGrantByTokenHash('h-beta');
    expect(betaGrant!.revokedAt).toBeNull();

    const capabilityGrant = await store.resolveGrantByTokenHash('h-capability');
    expect(capabilityGrant!.revokedAt).toBeNull();
  });

  it('capability grants (mintedByKeyId=null) survive revokeByKeyId for any device — NULL != keyId in SQL', async () => {
    await seedTwoDevicesAndGrants();
    await store.revokeByKeyId('k-alpha');
    await store.revokeByKeyId('k-beta');

    const capabilityGrant = await store.resolveGrantByTokenHash('h-capability');
    expect(capabilityGrant).not.toBeNull();
    expect(capabilityGrant!.revokedAt).toBeNull();
  });

  it('revokeByKeyId for an unknown keyId is a no-op — does not throw (robustness)', async () => {
    await expect(store.revokeByKeyId('no-such-key')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// revokeGrant idempotency (secSys, complements revokeByKeyId idempotency covered by devSys2)
// ---------------------------------------------------------------------------

describe('revokeGrant idempotency — secSys', () => {
  it('second revokeGrant call is a no-op — revokedAt preserves the first revoke timestamp', async () => {
    await store.mintGrant({
      grantId: 'g-idempotent', tokenHash: 'h-idempotent',
      principal: owner(FP_A), mintedByKeyId: 'k1',
      resource: workspaceResource(), scope: scopes('read'),
      expiresAtMs: null, createdAt: '2025-01-01T00:00:00Z',
    });
    await store.revokeGrant('g-idempotent');
    const afterFirst = await store.resolveGrantByTokenHash('h-idempotent');
    const firstRevokedAt = afterFirst!.revokedAt;
    expect(firstRevokedAt).not.toBeNull();

    // Second revoke is a no-op: the UPDATE carries a `revokedAt IS NULL` guard, so an already-revoked
    // row is untouched and the original revoke timestamp is preserved.
    await store.revokeGrant('g-idempotent');
    const afterSecond = await store.resolveGrantByTokenHash('h-idempotent');
    expect(afterSecond!.revokedAt).toBe(firstRevokedAt);
  });
});

// ---------------------------------------------------------------------------
// sweepExpiredChallenges boundary adversarial
// ---------------------------------------------------------------------------

describe('sweepExpiredChallenges — boundary adversarial (secSys)', () => {
  it('challenge at exactly expiresAtMs=serverNowMs is NOT swept — sweep uses <, not <= (boundary)', async () => {
    const NOW = 8000;
    await store.createChallenge({
      challengeId: 'c-at-boundary', nonce: 'n-boundary', keyId: 'k1',
      purpose: 'session', issuedAt: '2025-01-01T00:00:00Z', expiresAtMs: NOW,
    });
    await store.sweepExpiredChallenges(NOW);
    // Challenge is still in the DB (not swept); consumeChallenge with serverNowMs=NOW returns null
    // because the gate is >, not >= — but the row exists.
    const row = raw.prepare('SELECT * FROM authChallenges WHERE challengeId = ?').get('c-at-boundary');
    expect(row).not.toBeUndefined();
  });

  it('consumed + expired challenge IS swept by sweepExpiredChallenges (no ghost rows)', async () => {
    const PAST_TTL = 1000;
    await store.createChallenge({
      challengeId: 'c-spent-expired', nonce: 'n-spent', keyId: 'k1',
      purpose: 'session', issuedAt: '2025-01-01T00:00:00Z', expiresAtMs: PAST_TTL,
    });
    // Consume it (with nowMs=0 so it's still fresh at that moment)
    await store.consumeChallenge('c-spent-expired', 'session', 0);
    // Now sweep with nowMs > PAST_TTL
    await store.sweepExpiredChallenges(PAST_TTL + 1);
    const row = raw.prepare('SELECT * FROM authChallenges WHERE challengeId = ?').get('c-spent-expired');
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deviceSigningPublicKey — option-(b)/D5 per-device-key seam (planSys: NOT NULL, always populated)
// ---------------------------------------------------------------------------

describe('deviceSigningPublicKey seam (D5, NOT NULL)', () => {
  it('stores the supplied per-device key — v1 supplies signingPublicKey, Phase-2 the device key (round-trip)', async () => {
    // v1 route supplies the account signingPublicKey (strawman F1); Phase-2 supplies the device's own key.
    await store.registerDevice({
      keyId: 'k-seam-set', signingPublicKey: 'ACCT-PUB', deviceSigningPublicKey: 'DEVICE-PUB',
      accountFingerprint: FP_A, deviceLabel: 'seamed device', createdAt: '2025-01-01T00:00:00Z',
    });
    const row = raw
      .prepare('SELECT deviceSigningPublicKey FROM devices WHERE keyId = ?')
      .get('k-seam-set') as { deviceSigningPublicKey: string };
    expect(row.deviceSigningPublicKey).toBe('DEVICE-PUB');
  });

  it('a device row with NULL deviceSigningPublicKey is rejected — NOT NULL integrity (every device has a signing key)', () => {
    expect(() =>
      raw.exec(
        `INSERT INTO devices (keyId, signingPublicKey, accountFingerprint, deviceLabel, createdAt)
         VALUES ('k-no-seam', 'PUB', 'fp', 'd', '2025-01-01T00:00:00Z')`,
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// schema CHECK constraints — defense-in-depth (secSys finding 4)
// ---------------------------------------------------------------------------

describe('schema CHECK constraints (finding 4)', () => {
  it('rejects an out-of-set purpose at the DB boundary', () => {
    expect(() =>
      raw.exec(
        `INSERT INTO authChallenges (challengeId, nonce, purpose, issuedAt, expiresAtMs, consumed)
         VALUES ('c-bad-purpose', 'n', 'elevate', 'i', 999, 0)`,
      ),
    ).toThrow();
  });

  it('rejects a consumed value outside {0,1}', () => {
    expect(() =>
      raw.exec(
        `INSERT INTO authChallenges (challengeId, nonce, purpose, issuedAt, expiresAtMs, consumed)
         VALUES ('c-bad-consumed', 'n', 'session', 'i', 999, 2)`,
      ),
    ).toThrow();
  });
});
