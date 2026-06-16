import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import {
  base64urlEncode,
  base64urlDecodeStrict,
  canonicalAuthPayload,
  type Scope,
} from '@deltos/shared';
import app from '../src/index.js';
import { createAuthStore } from '../src/db/authStore.js';
import { hashToken } from '../src/authCrypto.js';
import type { DbAdapter } from '../src/db/schema.js';
import type { Env } from '../src/env.js';

/**
 * POST /api/auth/username — the D6 DIRECTORY-layer claim endpoint + the authStore claim primitive.
 *
 * The invariants under test (docs/design/secSys-account-identity-review.md S1, F-acct-4; planSys
 * binding conditions i/ii):
 *  - AUTHENTICATED-CLAIM-ONLY (F-acct-4): the claim is behind guard(); there is no unauthenticated
 *    availability oracle. "Taken" is revealed ONLY inside an authenticated claim (409).
 *  - INVARIANT (i): the alias binds to the AUTHENTICATED principal.id (= accountId), NEVER a body
 *    field. The `.strict` schema rejects a body accountId; the route reads principal.id server-side.
 *  - ATOMIC-UNIQUE claim (S1): INSERT-or-fail on the UNIQUE normalized key — two accounts racing the
 *    SAME name → exactly one 201, the other 409. No check-then-insert TOCTOU.
 *  - bind-once / append-only credential map (invariant ii foundation): a credential binds to exactly
 *    one account; a second bind throws (PK), and it can never be re-pointed to a different account.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
if (!ed.hashes.sha512) ed.hashes.sha512 = sha512;

const AUD = 'deltos.test';
const migrations = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0003_account-identity.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      sql,
      _params: [] as unknown[],
      bind(...p: unknown[]) {
        stmt._params = p;
        return stmt;
      },
      async first<T>() {
        return (raw.prepare(sql).get(...(stmt._params as never[])) ?? null) as T | null;
      },
      async all<T>() {
        return { results: raw.prepare(sql).all(...(stmt._params as never[])) as T[] };
      },
      async run() {
        const info = raw.prepare(sql).run(...(stmt._params as never[]));
        return { meta: { rows_written: info.changes } };
      },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(prepared: Array<{ sql: string; _params: unknown[] }>) {
      return prepared.map((s) => {
        const info = raw.prepare(s.sql).run(...(s._params as never[]));
        return { meta: { rows_written: info.changes } };
      });
    },
  } as unknown as D1Database;
}

// A direct DbAdapter over the same better-sqlite3 handle, for store-level (non-route) tests.
function sqliteAdapter(raw: Database.Database): DbAdapter {
  return {
    async batch(stmts) {
      const out: { rowsWritten: number }[] = [];
      raw.transaction(() => {
        for (const s of stmts) out.push({ rowsWritten: raw.prepare(s.sql).run(...(s.params as never[])).changes });
      })();
      return out;
    },
    async first<T>(sql: string, params: unknown[]) {
      return (raw.prepare(sql).get(...(params as never[])) ?? null) as T | null;
    },
    async all<T>(sql: string, params: unknown[]) {
      return raw.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

function freshDb(): Database.Database {
  const raw = new Database(':memory:');
  for (const m of migrations) raw.exec(m);
  return raw;
}

const makeEnv = (raw: Database.Database, over: Partial<Env> = {}): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, ...over }) as unknown as Env;

const postJson = (env: Env, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
    env,
  );

// --- signing helpers (mirror auth.routes.test.ts) ----------------------------------------------
function keypair(seedByte: number) {
  const priv = new Uint8Array(32).fill(seedByte);
  const pub = ed.getPublicKey(priv);
  return { priv, pub, pubB64: base64urlEncode(pub) };
}
const signB64 = (priv: Uint8Array, message: Uint8Array) => base64urlEncode(ed.sign(message, priv));

interface Challenge { challengeId: string; nonce: string; expiresAtMs: number }
async function mintChallenge(env: Env, body: unknown): Promise<Challenge> {
  const res = await postJson(env, '/api/auth/challenge', body);
  expect(res.status).toBe(200);
  return (await res.json()) as Challenge;
}

/** Register a device + return its keyId. */
async function registerDevice(env: Env, kp: ReturnType<typeof keypair>, label = 'phone') {
  const ch = await mintChallenge(env, { purpose: 'register' });
  const signature = signB64(
    kp.priv,
    canonicalAuthPayload({
      purpose: 'register',
      audience: AUD,
      challengeId: ch.challengeId,
      nonce: base64urlDecodeStrict(ch.nonce),
      signingPublicKey: kp.pub,
      deviceLabel: label,
    }),
  );
  const res = await postJson(env, '/api/auth/register', { challengeId: ch.challengeId, signingPublicKey: kp.pubB64, deviceLabel: label, signature });
  expect(res.status).toBe(201);
  return (await res.json()) as { keyId: string; accountFingerprint: string };
}

/** Full register → session for a keypair; returns the bearer token + its accountId (= principal.id). */
async function sessionFor(env: Env, kp: ReturnType<typeof keypair>, scope: Scope[] = ['read', 'write', 'create']) {
  const { keyId } = await registerDevice(env, kp);
  const ch = await mintChallenge(env, { purpose: 'session', keyId });
  const signature = signB64(
    kp.priv,
    canonicalAuthPayload({ purpose: 'session', audience: AUD, challengeId: ch.challengeId, nonce: base64urlDecodeStrict(ch.nonce), keyId, requestedScope: scope }),
  );
  const res = await postJson(env, '/api/auth/session', { challengeId: ch.challengeId, keyId, requestedScope: scope, signature });
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  return { token, keyId };
}

const claim = (env: Env, token: string, body: unknown) =>
  postJson(env, '/api/auth/username', body, { authorization: `Bearer ${token}` });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// ================================================================================================
describe('POST /api/auth/username — authenticated claim (F-acct-4)', () => {
  it('claims a free username → 201, echoing the display form', async () => {
    const env = makeEnv(freshDb());
    const { token } = await sessionFor(env, keypair(1));
    const res = await claim(env, token, { username: 'Alice' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ username: 'Alice' });
  });

  it('requires authentication — no bearer → refused, never claimed (no anonymous oracle)', async () => {
    const raw = freshDb();
    const env = makeEnv(raw, { ENVIRONMENT: 'production' }); // F13: unverified stub refused in prod
    const res = await postJson(env, '/api/auth/username', { username: 'alice' });
    expect(res.status).toBe(503);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM usernames').get()).toEqual({ n: 0 });
  });

  it('REJECTS a body-supplied accountId (.strict) — binds to principal.id only (invariant i)', async () => {
    const env = makeEnv(freshDb());
    const { token } = await sessionFor(env, keypair(2));
    const res = await claim(env, token, { username: 'bob', accountId: 'attacker-account' });
    expect(res.status).toBe(400);
  });

  it('a NON-account (capability/agent) principal cannot claim — 403, even with a create grant (invariant i)', async () => {
    // Mint a capability grant (kind=agent) with create+workspace scope so it PASSES can(); the
    // handler's account-bearing-kind guard must still refuse it — only an account may claim, so a
    // username can never bind to a capability/agent id (which is what principal.id would be here).
    const raw = freshDb();
    const env = makeEnv(raw);
    const store = createAuthStore(sqliteAdapter(raw));
    const token = 'cap-token-xyz';
    await store.mintGrant({
      grantId: 'g-cap',
      tokenHash: hashToken(token),
      principal: { kind: 'agent', id: 'capability-not-an-account' },
      mintedByKeyId: null,
      resource: { kind: 'workspace' },
      scope: ['create'],
      expiresAtMs: 4102444800000, // far future
      createdAt: 'now',
    });
    const res = await claim(env, token, { username: 'agentname' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM usernames').get()).toEqual({ n: 0 });
  });

  it('rejects an invalid username (reserved / charset / length) with 400 invalid_username', async () => {
    const env = makeEnv(freshDb());
    const { token } = await sessionFor(env, keypair(3));
    for (const bad of ['admin', 'bad name', 'ab', 'a'.repeat(33), '_lead']) {
      const res = await claim(env, token, { username: bad });
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_username');
    }
  });
});

describe('POST /api/auth/username — cross-account uniqueness + idempotency', () => {
  it('a second account claiming the same name → 409; the first holder is unchanged (no oracle leak)', async () => {
    const raw = freshDb();
    const env = makeEnv(raw);
    const a = await sessionFor(env, keypair(10));
    const b = await sessionFor(env, keypair(11));

    expect((await claim(env, a.token, { username: 'alice' })).status).toBe(201);

    const bRes = await claim(env, b.token, { username: 'ALICE' }); // casefold collision
    expect(bRes.status).toBe(409);
    const body = (await bRes.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('username_taken');
    expect(JSON.stringify(body)).not.toContain('account'); // 409 carries no holder identity

    // First holder's row is intact + still owned by A; B holds nothing.
    const row = raw.prepare('SELECT usernameDisplay, accountId FROM usernames WHERE usernameNormalized = ?').get('alice') as { usernameDisplay: string; accountId: string };
    expect(row.usernameDisplay).toBe('alice');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM usernames').get()).toEqual({ n: 1 });
  });

  it('same account re-claiming the SAME name is idempotent (200), not a conflict', async () => {
    const env = makeEnv(freshDb());
    const { token } = await sessionFor(env, keypair(12));
    expect((await claim(env, token, { username: 'Carol' })).status).toBe(201);
    const again = await claim(env, token, { username: 'carol' }); // same normalized
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ username: 'Carol' });
  });

  it('an account that already has a username cannot claim a different one (v1 rename OFF) → 409', async () => {
    const env = makeEnv(freshDb());
    const { token } = await sessionFor(env, keypair(13));
    expect((await claim(env, token, { username: 'dave' })).status).toBe(201);
    const other = await claim(env, token, { username: 'dave2' });
    expect(other.status).toBe(409);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe('username_exists');
  });
});

// ================================================================================================
describe('authStore.claimUsername — atomic-unique (no check-then-insert TOCTOU, secSys S1)', () => {
  const seedAccount = (raw: Database.Database, accountId: string) =>
    raw.prepare('INSERT INTO accounts (accountId, createdAt) VALUES (?, ?)').run(accountId, '2026-06-16T00:00:00.000Z');

  it('the UNIQUE PK is the sole arbiter: two accounts, same name → first wins, second loses to the holder', async () => {
    const raw = freshDb();
    seedAccount(raw, 'acct-A');
    seedAccount(raw, 'acct-B');
    const store = createAuthStore(sqliteAdapter(raw));

    const first = await store.claimUsername({ usernameNormalized: 'alice', accountId: 'acct-A', usernameDisplay: 'alice', createdAt: 'now' });
    expect(first).toEqual({ status: 'claimed' });

    const second = await store.claimUsername({ usernameNormalized: 'alice', accountId: 'acct-B', usernameDisplay: 'alice', createdAt: 'now' });
    expect(second).toEqual({ status: 'name-taken' }); // held by acct-A, no holder identity leaked

    expect(raw.prepare('SELECT COUNT(*) AS n FROM usernames').get()).toEqual({ n: 1 });
  });

  it('a same-account re-claim of its OWN name is idempotent, not a conflict', async () => {
    const raw = freshDb();
    seedAccount(raw, 'acct-A');
    const store = createAuthStore(sqliteAdapter(raw));
    await store.claimUsername({ usernameNormalized: 'alice', accountId: 'acct-A', usernameDisplay: 'Alice', createdAt: 'now' });
    const again = await store.claimUsername({ usernameNormalized: 'alice', accountId: 'acct-A', usernameDisplay: 'Alice', createdAt: 'now' });
    expect(again).toEqual({ status: 'idempotent', usernameDisplay: 'Alice' });
  });

  it('concurrent claims of the same name resolve to exactly one winner', async () => {
    const raw = freshDb();
    for (const id of ['a', 'b', 'c', 'd']) seedAccount(raw, id);
    const store = createAuthStore(sqliteAdapter(raw));
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) => store.claimUsername({ usernameNormalized: 'zed', accountId: id, usernameDisplay: 'zed', createdAt: 'now' })),
    );
    expect(results.filter((r) => r.status === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'name-taken')).toHaveLength(3);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM usernames').get()).toEqual({ n: 1 });
  });

  it('ATOMIC one-per-account: concurrent claims by the SAME account for DIFFERENT names → exactly one wins (secSys LOW fix)', async () => {
    // The per-account TOCTOU secSys flagged: a route-level check-then-insert let both concurrent claims
    // pass an existence read and both succeed (distinct name PKs), leaving the account with TWO names.
    // The UNIQUE(accountId) index + the 2nd ON CONFLICT target make the second insert fail atomically.
    const raw = freshDb();
    seedAccount(raw, 'acct-A');
    const store = createAuthStore(sqliteAdapter(raw));
    const names = ['bob', 'carol', 'dave', 'erin'];
    const results = await Promise.all(
      names.map((n) => store.claimUsername({ usernameNormalized: n, accountId: 'acct-A', usernameDisplay: n, createdAt: 'now' })),
    );
    expect(results.filter((r) => r.status === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'account-has-username')).toHaveLength(3);
    // The account holds EXACTLY ONE username — the invariant is DB-enforced, not check-then-insert.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM usernames WHERE accountId = ?').get('acct-A')).toEqual({ n: 1 });
  });

  it('getUsernameByAccount returns the account holding the name, null otherwise', async () => {
    const raw = freshDb();
    seedAccount(raw, 'acct-A');
    const store = createAuthStore(sqliteAdapter(raw));
    expect(await store.getUsernameByAccount('acct-A')).toBeNull();
    await store.claimUsername({ usernameNormalized: 'alice', accountId: 'acct-A', usernameDisplay: 'Alice', createdAt: 'now' });
    expect(await store.getUsernameByAccount('acct-A')).toEqual({ usernameDisplay: 'Alice', usernameNormalized: 'alice' });
    expect(await store.getUsernameByAccount('acct-unknown')).toBeNull();
  });
});

describe('authStore.bindCredential — bind-once / append-only (invariant ii foundation)', () => {
  const store = (raw: Database.Database) => createAuthStore(sqliteAdapter(raw));
  const seedAccount = (raw: Database.Database, accountId: string) =>
    raw.prepare('INSERT INTO accounts (accountId, createdAt) VALUES (?, ?)').run(accountId, 'now');

  it('a credential binds to exactly ONE account; a second bind of the same fingerprint throws', async () => {
    const raw = freshDb();
    seedAccount(raw, 'acct-A');
    const s = store(raw);
    await s.bindCredential({ accountFingerprint: 'fp-1', accountId: 'acct-A', credentialType: 'signing-key-v1', addedAt: 'now' });
    await expect(
      s.bindCredential({ accountFingerprint: 'fp-1', accountId: 'acct-A', credentialType: 'signing-key-v1', addedAt: 'now' }),
    ).rejects.toThrow();
  });

  it('a bound credential can NEVER be re-pointed to a DIFFERENT account (re-bind throws; mapping intact)', async () => {
    const raw = freshDb();
    seedAccount(raw, 'acct-A');
    seedAccount(raw, 'acct-B');
    const s = store(raw);
    await s.bindCredential({ accountFingerprint: 'fp-1', accountId: 'acct-A', credentialType: 'signing-key-v1', addedAt: 'now' });
    await expect(
      s.bindCredential({ accountFingerprint: 'fp-1', accountId: 'acct-B', credentialType: 'signing-key-v1', addedAt: 'now' }),
    ).rejects.toThrow();
    // The original A→fp-1 binding is untouched (no re-point).
    expect(await s.resolveAccountIdByFingerprint('fp-1')).toBe('acct-A');
  });
});
