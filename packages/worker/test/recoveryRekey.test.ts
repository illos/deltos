/**
 * #50 — recovery-accountId-rekey HARDENING. The recovery verifier folds accountId into its Argon2id
 * pre-image (AP-T10, intentional, secSys-reviewed — do NOT de-key), while password + the TOTP secret are
 * accountId-INDEPENDENT. So a re-key of an account's accountId silently strands recovery-phrase reset:
 * a 100%-correct phrase 401s (verify recomputes the hash under the NEW id ≠ the stored hash under the OLD
 * id) while password login still works. The phrase is one-way, so it can't be re-hashed — the only
 * correct response (secSys #76/#201) is RE-ESTABLISH: invalidate the verifier to the canonical
 * unestablished sentinel + clear the flag, so the P0 belt forces a fresh /recovery/rotate (re-keying
 * recovery to the NEW accountId) at next login. This proves recovery FOLLOWS the key.
 *
 * NOTE: there is NO runtime re-key path today (accountId is immutable; the only historical SET accountId
 * was migration 0003). This primitive is the preventive, fail-closed building block any FUTURE re-key
 * (migration / account-merge / add-credential / credential-rebind) MUST call — see the contract at
 * authStore.createAccount.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { DbAdapter } from '../src/db/schema.js';
import { createAuthStore } from '../src/db/authStore.js';
import {
  hashRecoveryPhrase,
  verifyRecoveryPhrase,
  isPhc,
  generateRecoveryPhrase,
  UNESTABLISHED_VERIFIER,
} from '../src/passwordCrypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAST = { m: 256, t: 1, p: 1 } as const; // tiny Argon2 — keep the suite snappy
const PEPPER = 'recovery-rekey-test-pepper';
const NOW = '2026-06-21T00:00:00.000Z';
const A = 'acct-OLD-key-0001'; // the accountId the recoveryPhc was hashed under
const B = 'acct-NEW-key-0002'; // the accountId after a (hypothetical) re-key

const migrations = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql',
  '0018_fts5-note-search.sql', '0019_note-routing-guide.sql', // FTS table; searchIndex.ts is invoked by the note mutators (0018)
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function sqliteAdapter(db: Database.Database): DbAdapter {
  return {
    async batch(stmts) {
      const results: Array<{ rowsWritten: number }> = [];
      db.transaction(() => {
        for (const s of stmts) results.push({ rowsWritten: db.prepare(s.sql).run(...(s.params as Array<string | number | null>)).changes });
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
function fresh() {
  const raw = new Database(':memory:');
  for (const m of migrations) raw.exec(m);
  return createAuthStore(sqliteAdapter(raw));
}

describe('#50 invalidateRecoveryForRekey — recovery follows the accountId on a re-key', () => {
  it('re-key STRANDS recovery (correct phrase fails under the new key); invalidate → re-establish restores it', async () => {
    const store = fresh();
    const phrase = generateRecoveryPhrase();

    // Post-rekey stranded state: the credential row now lives under accountId B, but its recoveryPhc was
    // hashed under the OLD accountId A (a re-key that moved accountId without re-keying recovery).
    await store.createAccount({ accountId: B, createdAt: NOW });
    await store.createPasswordCredential({
      accountId: B,
      passwordPhc: 'pw-phc-irrelevant-to-recovery',
      recoveryPhc: hashRecoveryPhrase(phrase, A, PEPPER, FAST), // keyed to the OLD id A
      createdAt: NOW,
    });
    await store.setRecoveryEstablished(B, true, NOW);

    // BRITTLENESS: a 100%-correct phrase does NOT verify under the CURRENT (new) accountId B...
    const cred0 = await store.getCredentialByAccount(B);
    expect(cred0!.recoveryEstablished).toBe(true);
    expect(verifyRecoveryPhrase(phrase, B, cred0!.recoveryPhc, PEPPER)).toBe(false); // stranded
    // ...but WOULD verify under the old id A — proving it's an accountId mismatch, not a wrong phrase.
    expect(verifyRecoveryPhrase(phrase, A, cred0!.recoveryPhc, PEPPER)).toBe(true);

    // HARDENING: on a re-key, invalidate → canonical sentinel + recoveryEstablished cleared (atomic).
    await store.invalidateRecoveryForRekey(B, UNESTABLISHED_VERIFIER, NOW);
    const cred1 = await store.getCredentialByAccount(B);
    expect(cred1!.recoveryEstablished).toBe(false); // P0-belt forces a fresh phrase at next login
    expect(isPhc(cred1!.recoveryPhc)).toBe(false); // sentinel → /reset isPhc→false → dummy → honest fail()
    expect(cred1!.recoveryPhc).toBe(UNESTABLISHED_VERIFIER); // EXACT canonical const (byte-identical fail path)

    // RE-ESTABLISH under the NEW key (what /recovery/rotate does with principal.id = B).
    const phrase2 = generateRecoveryPhrase();
    await store.updateRecoveryHash(B, hashRecoveryPhrase(phrase2, B, PEPPER, FAST), NOW);
    await store.setRecoveryEstablished(B, true, NOW);
    const cred2 = await store.getCredentialByAccount(B);
    expect(verifyRecoveryPhrase(phrase2, B, cred2!.recoveryPhc, PEPPER)).toBe(true); // recovery FOLLOWS the new key
  });

  it('idempotent: invalidating an already-unestablished account is a harmless no-op', async () => {
    const store = fresh();
    await store.createAccount({ accountId: B, createdAt: NOW });
    await store.createPasswordCredential({ accountId: B, passwordPhc: 'pw', recoveryPhc: UNESTABLISHED_VERIFIER, createdAt: NOW });
    await store.invalidateRecoveryForRekey(B, UNESTABLISHED_VERIFIER, NOW);
    const cred = await store.getCredentialByAccount(B);
    expect(cred!.recoveryEstablished).toBe(false);
    expect(cred!.recoveryPhc).toBe(UNESTABLISHED_VERIFIER);
  });
});
