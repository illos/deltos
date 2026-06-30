/**
 * authStore tests — the pure-D1 identity data layer (db/authStore.ts) over migration 0002.
 *
 * Run against better-sqlite3 (D1-compatible SQLite), applying the SAME migration files production
 * D1 uses, so the camelCase columns + the atomic-consume CAS are exercised exactly as deployed.
 *
 * Correctness focus (contract docs/design/stream-a-auth-contracts.md §1):
 *  - consumeChallenge is the SOLE single-use + freshness authority, decided by rows-affected of one
 *    atomic UPDATE…RETURNING (no read-then-check). [AUTH-1 × R3-1]
 *  - grants store/lookup by hash only (F6); resolve returns the row regardless of revoked/expired
 *    so the chokepoint decides.
 *  - revokeByKeyId revokes the device row AND that device's outstanding grants, scoped by
 *    mintedByKeyId, without touching other devices' grants. [PIN-ID-5 + checklist §F]
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

// better-sqlite3 adapter (mirrors d1Adapter + the conflict-test double; RETURNING via .get()).
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

const migrations = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0014_grant-family-link.sql',
  '0015_audit-log.sql',
  '0016_usage-counter.sql', // adds grants.familyId (the mintGrant INSERT lists it) — ALTER works on the 0002 table
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function freshStore() {
  const raw = new Database(':memory:');
  for (const migration of migrations) raw.exec(migration);
  return createAuthStore(sqliteAdapter(raw));
}

// Helpers to build branded domain values the way the chokepoint would.
const owner = (id: string) => PrincipalSchema.parse({ kind: 'owner', id });
const notebookResource = (id: string) => ResourceSchema.parse({ kind: 'notebook', id });
const workspaceResource = () => ResourceSchema.parse({ kind: 'workspace' });
const scopes = (...s: string[]) => s.map((x) => ScopeSchema.parse(x)) as Scope[];

const UUID_A = '11111111-1111-4111-8111-111111111111';
const FUTURE = 10_000; // expiresAtMs well past any test "now"

let store: ReturnType<typeof createAuthStore>;
beforeEach(() => {
  store = freshStore();
});

describe('challenges — atomic single-use + freshness consume', () => {
  it('consumes a fresh challenge exactly once and returns the server-held nonce/keyId', async () => {
    await store.createChallenge({
      challengeId: 'c1',
      nonce: 'NONCE1',
      keyId: 'k1',
      purpose: 'session',
      issuedAt: '2026-06-16T00:00:00.000Z',
      expiresAtMs: FUTURE,
    });

    const first = await store.consumeChallenge('c1', 'session', 0);
    expect(first).toEqual({ nonce: 'NONCE1', keyId: 'k1' });

    // Replay loses the race: the row is already consumed → null.
    const second = await store.consumeChallenge('c1', 'session', 0);
    expect(second).toBeNull();
  });

  it('rejects (and does not consume) an EXPIRED challenge — freshness is in the CAS', async () => {
    await store.createChallenge({
      challengeId: 'c2',
      nonce: 'N',
      keyId: 'k1',
      purpose: 'session',
      issuedAt: '2026-06-16T00:00:00.000Z',
      expiresAtMs: 5_000,
    });
    // now == expiry boundary → strict > means rejected.
    expect(await store.consumeChallenge('c2', 'session', 5_000)).toBeNull();
    // now past expiry → rejected.
    expect(await store.consumeChallenge('c2', 'session', 9_999)).toBeNull();
  });

  it('rejects a WRONG-PURPOSE consume and leaves the challenge spendable for the right purpose', async () => {
    await store.createChallenge({
      challengeId: 'c3',
      nonce: 'N',
      keyId: 'k1',
      purpose: 'session',
      issuedAt: '2026-06-16T00:00:00.000Z',
      expiresAtMs: FUTURE,
    });
    // Wrong purpose: no match → null, and crucially NOT consumed.
    expect(await store.consumeChallenge('c3', 'step-up', 0)).toBeNull();
    // Correct purpose still works → proves the wrong-purpose attempt did not consume it.
    expect(await store.consumeChallenge('c3', 'session', 0)).toEqual({ nonce: 'N', keyId: 'k1' });
  });

  it('returns keyId=null for a register challenge (no key yet)', async () => {
    await store.createChallenge({
      challengeId: 'c4',
      nonce: 'N',
      keyId: null,
      purpose: 'register',
      issuedAt: '2026-06-16T00:00:00.000Z',
      expiresAtMs: FUTURE,
    });
    expect(await store.consumeChallenge('c4', 'register', 0)).toEqual({ nonce: 'N', keyId: null });
  });

  it('returns null for an unknown challengeId', async () => {
    expect(await store.consumeChallenge('nope', 'session', 0)).toBeNull();
  });

  it('sweepExpiredChallenges deletes expired rows and leaves fresh ones consumable', async () => {
    await store.createChallenge({ challengeId: 'old', nonce: 'N', keyId: 'k1', purpose: 'session', issuedAt: 'i', expiresAtMs: 1_000 });
    await store.createChallenge({ challengeId: 'new', nonce: 'N2', keyId: 'k1', purpose: 'session', issuedAt: 'i', expiresAtMs: FUTURE });

    await store.sweepExpiredChallenges(5_000);

    // 'old' is gone; 'new' survives and is still consumable.
    expect(await store.consumeChallenge('old', 'session', 0)).toBeNull();
    expect(await store.consumeChallenge('new', 'session', 0)).toEqual({ nonce: 'N2', keyId: 'k1' });
  });
});

describe('devices — register / get / list', () => {
  it('registers a device and reads it back; unknown keyId is null', async () => {
    await store.registerDevice({
      keyId: 'k1',
      signingPublicKey: 'PUB1',
      deviceSigningPublicKey: 'PUB1',
      accountFingerprint: 'ACC',
      deviceLabel: 'phone',
      createdAt: '2026-06-16T00:00:00.000Z',
    });
    expect(await store.getDevice('k1')).toEqual({
      signingPublicKey: 'PUB1',
      accountFingerprint: 'ACC',
      revokedAt: null,
    });
    expect(await store.getDevice('missing')).toBeNull();
  });

  it('lists all devices for an account, not other accounts', async () => {
    await store.registerDevice({ keyId: 'k1', signingPublicKey: 'P1', deviceSigningPublicKey: 'P1', accountFingerprint: 'ACC', deviceLabel: 'a', createdAt: '2026-06-16T00:00:01.000Z' });
    await store.registerDevice({ keyId: 'k2', signingPublicKey: 'P1', deviceSigningPublicKey: 'P1', accountFingerprint: 'ACC', deviceLabel: 'b', createdAt: '2026-06-16T00:00:02.000Z' });
    await store.registerDevice({ keyId: 'k3', signingPublicKey: 'P9', deviceSigningPublicKey: 'P9', accountFingerprint: 'OTHER', deviceLabel: 'c', createdAt: '2026-06-16T00:00:03.000Z' });

    const devices = await store.listDevices('ACC');
    expect(devices.map((d) => d.keyId)).toEqual(['k1', 'k2']);
  });
});

describe('grants — hashed mint / resolve round-trip', () => {
  it('mints a grant and resolves it by hash, round-tripping principal/resource/scope', async () => {
    await store.mintGrant({
      grantId: 'g1',
      tokenHash: 'HASH1',
      principal: owner('ACC'),
      mintedByKeyId: 'k1',
      resource: notebookResource(UUID_A),
      scope: scopes('read', 'write'),
      expiresAtMs: FUTURE,
      createdAt: '2026-06-16T00:00:00.000Z',
    });

    const resolved = await store.resolveGrantByTokenHash('HASH1');
    expect(resolved).toMatchObject({
      grantId: 'g1',
      principal: { kind: 'owner', id: 'ACC' },
      resource: { kind: 'notebook', id: UUID_A },
      scope: ['read', 'write'],
      expiresAtMs: FUTURE,
      revokedAt: null,
    });
  });

  it('round-trips a workspace resource (null resourceId)', async () => {
    await store.mintGrant({
      grantId: 'g2',
      tokenHash: 'HASH2',
      principal: owner('ACC'),
      mintedByKeyId: null,
      resource: workspaceResource(),
      scope: scopes('read'),
      expiresAtMs: null,
      createdAt: '2026-06-16T00:00:00.000Z',
    });
    const resolved = await store.resolveGrantByTokenHash('HASH2');
    expect(resolved?.resource).toEqual({ kind: 'workspace' });
    expect(resolved?.expiresAtMs).toBeNull();
  });

  it('returns null for an unknown token hash', async () => {
    expect(await store.resolveGrantByTokenHash('nope')).toBeNull();
  });
});

describe('revocation', () => {
  it('revokeGrant marks the row revoked but it still RESOLVES (chokepoint decides the deny)', async () => {
    await store.mintGrant({
      grantId: 'g1', tokenHash: 'H', principal: owner('ACC'), mintedByKeyId: 'k1',
      resource: workspaceResource(), scope: scopes('read'), expiresAtMs: FUTURE, createdAt: 'c',
    });
    await store.revokeGrant('g1');

    const resolved = await store.resolveGrantByTokenHash('H');
    expect(resolved).not.toBeNull();
    expect(resolved?.revokedAt).not.toBeNull(); // present → chokepoint denies
  });

  it('revokeByKeyId revokes the device AND that device\'s outstanding grants — scoped by mintedByKeyId', async () => {
    await store.registerDevice({ keyId: 'k1', signingPublicKey: 'P', deviceSigningPublicKey: 'P', accountFingerprint: 'ACC', deviceLabel: 'a', createdAt: 'c' });

    // Two grants minted by k1, one minted by a different device, one capability grant (null).
    await store.mintGrant({ grantId: 'g1', tokenHash: 'H1', principal: owner('ACC'), mintedByKeyId: 'k1', resource: workspaceResource(), scope: scopes('read'), expiresAtMs: FUTURE, createdAt: 'c' });
    await store.mintGrant({ grantId: 'g2', tokenHash: 'H2', principal: owner('ACC'), mintedByKeyId: 'k1', resource: workspaceResource(), scope: scopes('write'), expiresAtMs: FUTURE, createdAt: 'c' });
    await store.mintGrant({ grantId: 'g3', tokenHash: 'H3', principal: owner('ACC'), mintedByKeyId: 'k2', resource: workspaceResource(), scope: scopes('read'), expiresAtMs: FUTURE, createdAt: 'c' });
    await store.mintGrant({ grantId: 'g4', tokenHash: 'H4', principal: owner('ACC'), mintedByKeyId: null, resource: workspaceResource(), scope: scopes('read'), expiresAtMs: FUTURE, createdAt: 'c' });

    await store.revokeByKeyId('k1');

    // Device row revoked (blocks future mints via session route's getDevice check).
    expect((await store.getDevice('k1'))?.revokedAt).not.toBeNull();
    // k1's grants revoked...
    expect((await store.resolveGrantByTokenHash('H1'))?.revokedAt).not.toBeNull();
    expect((await store.resolveGrantByTokenHash('H2'))?.revokedAt).not.toBeNull();
    // ...but the other device's grant and the capability grant are untouched.
    expect((await store.resolveGrantByTokenHash('H3'))?.revokedAt).toBeNull();
    expect((await store.resolveGrantByTokenHash('H4'))?.revokedAt).toBeNull();
  });

  it('revokeByKeyId is idempotent — re-revoking preserves the first revoke time', async () => {
    await store.registerDevice({ keyId: 'k1', signingPublicKey: 'P', deviceSigningPublicKey: 'P', accountFingerprint: 'ACC', deviceLabel: 'a', createdAt: 'c' });
    await store.mintGrant({ grantId: 'g1', tokenHash: 'H1', principal: owner('ACC'), mintedByKeyId: 'k1', resource: workspaceResource(), scope: scopes('read'), expiresAtMs: FUTURE, createdAt: 'c' });

    await store.revokeByKeyId('k1');
    const firstRevoke = (await store.getDevice('k1'))?.revokedAt;
    const firstGrantRevoke = (await store.resolveGrantByTokenHash('H1'))?.revokedAt;

    await store.revokeByKeyId('k1');
    expect((await store.getDevice('k1'))?.revokedAt).toBe(firstRevoke);
    expect((await store.resolveGrantByTokenHash('H1'))?.revokedAt).toBe(firstGrantRevoke);
  });
});
