/**
 * Account-identity foundation (D6, migration 0003) — the ZERO-DELTA re-point, end to end.
 *
 * planSys's THREE binding conditions on the re-point live here:
 *  (2) SEMANTIC test — assert principal.id resolves to accountId (NOT accountFingerprint) end-to-end
 *      through register → session → resolveGrantByTokenHash, AND that the credential paths still
 *      resolve the fingerprint. This FAILS if any site reverts to id == fingerprint (false-green guard).
 *  (3) TWO-ACCOUNT negative isolation — A's data is invisible to B THROUGH the re-pointed id.
 *  + S5 migration safety: the back-fill assigns the single dev account + re-points existing owner
 *    grants; the >1-account guard FAILS LOUD.
 *
 * The authStore-level semantic test is here in the foundation; the route-level mint→use semantic
 * path is exercised in auth.acceptance.test.ts as those flows go live.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { DbAdapter } from '../src/db/schema.js';
import { createAuthStore } from '../src/db/authStore.js';
import { getNoteForAccount } from '../src/db/accountScope.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationFiles = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0003_account-identity.sql',
  '0014_grant-family-link.sql',
  '0015_audit-log.sql',
  '0016_usage-counter.sql',
  '0017_oauth-provider.sql', // adds grants.familyId (the mintGrant INSERT lists it); appended LAST to keep slice/index below valid
];
const migrations = migrationFiles.map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));
const preAccountMigrations = migrations.slice(0, 3); // 0000–0002, before the account dimension
const migration0003 = migrations[3]!;

function sqliteAdapter(db: Database.Database): DbAdapter {
  return {
    async batch(stmts) {
      const results: { rowsWritten: number }[] = [];
      db.transaction(() => {
        for (const s of stmts) {
          const info = db.prepare(s.sql).run(...(s.params as Array<string | number | null>));
          results.push({ rowsWritten: info.changes });
        }
      })();
      return results;
    },
    async first<T>(sql: string, params: unknown[]) {
      return (db.prepare(sql).get(...(params as Array<string | number | null>)) ?? null) as T | null;
    },
    async all<T>(sql: string, params: unknown[]) {
      return db.prepare(sql).all(...(params as Array<string | number | null>)) as T[];
    },
  };
}

function freshDb(): Database.Database {
  const raw = new Database(':memory:');
  for (const m of migrations) raw.exec(m);
  return raw;
}

const FINGERPRINT = 'fp-account-credential-v1';

describe('SEMANTIC (condition 2): principal.id resolves to accountId, NOT accountFingerprint', () => {
  it('mint a grant keyed on accountId → resolveGrantByTokenHash surfaces principal.id == accountId (!= fingerprint)', async () => {
    const raw = freshDb();
    const store = createAuthStore(sqliteAdapter(raw));

    // Enroll: a fresh account bound to the credential fingerprint (what /register does).
    const accountId = 'acct-random-immutable';
    await store.createAccount({ accountId, createdAt: '2026-06-16T00:00:00.000Z' });
    await store.bindCredential({
      accountFingerprint: FINGERPRINT,
      accountId,
      credentialType: 'signing-key-v1',
      addedAt: '2026-06-16T00:00:00.000Z',
    });

    // The credential -> account resolution the session route uses to stamp the grant.
    const resolved = await store.resolveAccountIdByFingerprint(FINGERPRINT);
    expect(resolved).toBe(accountId);

    // Mint keyed on accountId (the re-point), credential tracked via mintedByKeyId.
    await store.mintGrant({
      grantId: 'g1',
      tokenHash: 'hash-1',
      principal: { kind: 'owner', id: accountId },
      mintedByKeyId: 'key-1',
      resource: { kind: 'workspace' },
      scope: ['read', 'write'],
      expiresAtMs: null,
      createdAt: '2026-06-16T00:00:00.000Z',
    });

    const grant = await store.resolveGrantByTokenHash('hash-1');
    expect(grant).not.toBeNull();
    // THE false-green guard: the resolved principal id MUST be the accountId, and MUST NOT be the fingerprint.
    expect(grant!.principal.id).toBe(accountId);
    expect(grant!.principal.id).not.toBe(FINGERPRINT);
  });

  it('credential paths still resolve the FINGERPRINT (not the accountId) — devices keyed on fingerprint', async () => {
    const raw = freshDb();
    const store = createAuthStore(sqliteAdapter(raw));
    const accountId = 'acct-1';
    await store.createAccount({ accountId, createdAt: '2026-06-16T00:00:00.000Z' });
    await store.bindCredential({ accountFingerprint: FINGERPRINT, accountId, credentialType: 'signing-key-v1', addedAt: '2026-06-16T00:00:00.000Z' });
    await store.registerDevice({
      keyId: 'key-1',
      signingPublicKey: 'pk',
      deviceSigningPublicKey: 'pk',
      accountFingerprint: FINGERPRINT,
      deviceLabel: 'phone',
      createdAt: '2026-06-16T00:00:00.000Z',
    });

    // The device record still carries the CREDENTIAL fingerprint (F2) — never the accountId.
    const device = await store.getDevice('key-1');
    expect(device!.accountFingerprint).toBe(FINGERPRINT);
    // And the account's device list resolves by accountId via accountCredentials.
    const devices = await store.listDevicesByAccount(accountId);
    expect(devices.map((d) => d.keyId)).toEqual(['key-1']);
  });
});

describe('TWO-ACCOUNT isolation (condition 3): A is invisible to B through the re-pointed id', () => {
  it("getNoteForAccount(B, A's note) is null; each account sees only its own", async () => {
    const raw = freshDb();
    const db = sqliteAdapter(raw);
    const seed = (id: string, accountId: string) =>
      raw
        .prepare(
          `INSERT INTO notes (id, notebookId, title, properties, body, version, createdAt, updatedAt, accountId)
           VALUES (?, 'nb', '', '{}', '[]', 1, '2026-06-16T00:00:00.000Z', '2026-06-16T00:00:00.000Z', ?)`,
        )
        .run(id, accountId);
    seed('note-A', 'acct-A');
    seed('note-B', 'acct-B');

    expect(await getNoteForAccount(db, 'acct-A', 'note-A')).not.toBeNull();
    expect(await getNoteForAccount(db, 'acct-B', 'note-A')).toBeNull(); // B cannot read A's note
    expect(await getNoteForAccount(db, 'acct-A', 'note-B')).toBeNull(); // A cannot read B's note
  });
});

describe('S5 migration safety — back-fill + re-point + the >1-account guard', () => {
  /** Apply 0000–0002, seed pre-account data, then apply 0003 and return raw. */
  function migrateWithSeed(seed: (raw: Database.Database) => void): Database.Database {
    const raw = new Database(':memory:');
    for (const m of preAccountMigrations) raw.exec(m);
    seed(raw);
    raw.exec(migration0003);
    return raw;
  }

  it('FRESH (empty) DB migrates cleanly — no account created, no rows touched', () => {
    const raw = migrateWithSeed(() => {});
    expect((raw.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(0);
  });

  it('single dev account: back-fills notes.accountId + binds the credential + re-points the owner grant', () => {
    const raw = migrateWithSeed((db) => {
      db.prepare(
        `INSERT INTO devices (keyId, signingPublicKey, deviceSigningPublicKey, accountFingerprint, deviceLabel, createdAt)
         VALUES ('k1','pk','pk',?,'phone','2026-06-16T00:00:00.000Z')`,
      ).run(FINGERPRINT);
      db.prepare(
        `INSERT INTO notes (id, notebookId, title, properties, body, version, createdAt, updatedAt)
         VALUES ('n1','nb','','{}','[]',1,'2026-06-16T00:00:00.000Z','2026-06-16T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO grants (grantId, tokenHash, principalKind, principalId, mintedByKeyId, resourceKind, resourceId, scope, expiresAtMs, revokedAt, createdAt)
         VALUES ('g1','h1','owner',?, 'k1','workspace',NULL,'["read"]',NULL,NULL,'2026-06-16T00:00:00.000Z')`,
      ).run(FINGERPRINT);
    });

    const accountId = (raw.prepare('SELECT accountId FROM accounts LIMIT 1').get() as { accountId: string }).accountId;
    expect(accountId).toMatch(/^[0-9a-f]{32}$/); // random >=16B as hex

    // credential bound to the account
    const cred = raw.prepare('SELECT accountId FROM accountCredentials WHERE accountFingerprint = ?').get(FINGERPRINT) as { accountId: string };
    expect(cred.accountId).toBe(accountId);

    // notes back-filled to the account
    const note = raw.prepare("SELECT accountId FROM notes WHERE id = 'n1'").get() as { accountId: string | null };
    expect(note.accountId).toBe(accountId);

    // owner grant principalId RE-POINTED fingerprint -> accountId (credential still tracked via mintedByKeyId)
    const grant = raw.prepare("SELECT principalId, mintedByKeyId FROM grants WHERE grantId = 'g1'").get() as { principalId: string; mintedByKeyId: string };
    expect(grant.principalId).toBe(accountId);
    expect(grant.principalId).not.toBe(FINGERPRINT);
    expect(grant.mintedByKeyId).toBe('k1');
  });

  it('capability grants are NOT re-pointed (principalId stays the capability id)', () => {
    const raw = migrateWithSeed((db) => {
      db.prepare(
        `INSERT INTO devices (keyId, signingPublicKey, deviceSigningPublicKey, accountFingerprint, deviceLabel, createdAt)
         VALUES ('k1','pk','pk',?,'phone','2026-06-16T00:00:00.000Z')`,
      ).run(FINGERPRINT);
      db.prepare(
        `INSERT INTO grants (grantId, tokenHash, principalKind, principalId, mintedByKeyId, resourceKind, resourceId, scope, expiresAtMs, revokedAt, createdAt)
         VALUES ('cap1','hcap','guest','share-capability-id',NULL,'note','n1','["read"]',NULL,NULL,'2026-06-16T00:00:00.000Z')`,
      ).run();
    });
    const cap = raw.prepare("SELECT principalId FROM grants WHERE grantId = 'cap1'").get() as { principalId: string };
    expect(cap.principalId).toBe('share-capability-id');
  });

  it('GUARD: >1 distinct account fingerprint in existing data FAILS LOUD (migration aborts)', () => {
    expect(() =>
      migrateWithSeed((db) => {
        const ins = db.prepare(
          `INSERT INTO devices (keyId, signingPublicKey, deviceSigningPublicKey, accountFingerprint, deviceLabel, createdAt)
           VALUES (?, 'pk','pk',?,'phone','2026-06-16T00:00:00.000Z')`,
        );
        ins.run('k1', 'fp-account-A');
        ins.run('k2', 'fp-account-B'); // a SECOND distinct account → ambiguous → must abort
      }),
    ).toThrow(); // the temp-table CHECK (n <= 1) rejects the INSERT and aborts the migration
  });
});
