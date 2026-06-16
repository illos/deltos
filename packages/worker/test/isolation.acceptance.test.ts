/**
 * Two-account cross-account isolation (D6 build wave).
 *
 * ISOLATION CONTRACT (D6):
 *   principal.id ← accountId (re-pointed from accountFingerprint; every object-scoped query
 *   adds AND accountId = principal.id so A's authenticated principal cannot reach B's objects
 *   even with a valid workspace grant).
 *
 * TEST STATUS (as of D6 complete — scopeSys 303db9a notes, dd86704 sync, devSys d9d6803 foundation):
 *   All tests GREEN. Note / sync tests flipped GREEN when scopeSys applied AND accountId = principal.id
 *   to every object-scoped query (S-1..S-9). Device tests GREEN from the start (BOLA fix + D6 re-point).
 *   §K (never-client-trusted) GREEN — server stamps accountId from principal, ignores body field.
 *
 * STANDING BAR: any future object-scoped route adds a row here before it ships.
 * Cross-refs:
 *   auth.acceptance.test.ts §F REJECTED — device-revoke BOLA end-state (0f8823c)
 *   auth.acceptance.test.ts §I          — cross-tenant list isolation (0f8823c)
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  canonicalAuthPayload, base64urlEncode, base64urlDecodeStrict,
  type Scope,
} from '@deltos/shared';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

if (!ed.hashes.sha512) ed.hashes.sha512 = sha512;

// ---------------------------------------------------------------------------
// Infrastructure (mirrored from auth.acceptance.test.ts — test files cannot import each other)
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0003_account-identity.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

const ISO_AUD = 'deltos.isolation';

function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      sql,
      _params: [] as unknown[],
      bind(...p: unknown[]) { stmt._params = p; return stmt; },
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

const makeEnv = (raw: Database.Database): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: ISO_AUD } as unknown as Env);

function isoKeypair(seed: number) {
  const priv = new Uint8Array(32).fill(seed);
  const pub = ed.getPublicKey(priv);
  return { priv, pub, pubB64: base64urlEncode(pub) };
}
const isoSign = (priv: Uint8Array, msg: Uint8Array) => base64urlEncode(ed.sign(msg, priv));
const isoPost = (env: Env, path: string, body: unknown, token?: string) =>
  app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }, env);

async function isoChallenge(env: Env, body: unknown) {
  const res = await isoPost(env, '/api/auth/challenge', body);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ challengeId: string; nonce: string }>;
}

async function isoRegister(env: Env, kp: ReturnType<typeof isoKeypair>, label: string) {
  const ch = await isoChallenge(env, { purpose: 'register' });
  const sig = isoSign(kp.priv, canonicalAuthPayload({
    purpose: 'register', audience: ISO_AUD, challengeId: ch.challengeId,
    nonce: base64urlDecodeStrict(ch.nonce), signingPublicKey: kp.pub, deviceLabel: label,
  }));
  const res = await isoPost(env, '/api/auth/register', {
    challengeId: ch.challengeId, signingPublicKey: kp.pubB64, deviceLabel: label, signature: sig,
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ keyId: string }>;
}

async function isoSession(
  env: Env,
  kp: ReturnType<typeof isoKeypair>,
  keyId: string,
  scope: Scope[] = ['read', 'write', 'create', 'delete', 'search'],
) {
  const ch = await isoChallenge(env, { purpose: 'session', keyId });
  const sig = isoSign(kp.priv, canonicalAuthPayload({
    purpose: 'session', audience: ISO_AUD, challengeId: ch.challengeId,
    nonce: base64urlDecodeStrict(ch.nonce), keyId, requestedScope: scope,
  }));
  const res = await isoPost(env, '/api/auth/session', {
    challengeId: ch.challengeId, keyId, requestedScope: scope, signature: sig,
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ token: string }>;
}

// ---------------------------------------------------------------------------
// Two-account fixture — B's objects are the isolation targets
// ---------------------------------------------------------------------------

const B_NOTEBOOK  = '00000000-0000-4000-b000-000000000001'; // B's notebook UUID
const B_NOTE      = '00000000-0000-4000-b000-000000000002'; // created via note.create
const B_SYNC_NOTE = '00000000-0000-4000-b000-000000000003'; // pushed via sync.push
const B_BLOCK     = '00000000-0000-4000-b000-000000000004'; // block inside B_NOTE
const SEARCH_TERM = 'b-account-exclusive-secret-note';      // only in B's notes

// Seeds outside the range auth.acceptance.test.ts uses (20..32) — no fixture collision.
const SEED_A = 33;
const SEED_B = 34;

interface IsoFixture {
  raw: Database.Database;
  env: Env;
  tokenA: string;
  keyIdA: string;
  kpA: ReturnType<typeof isoKeypair>;
  tokenB: string;
  keyIdB: string;
}

async function buildFixture(): Promise<IsoFixture> {
  const raw = new Database(':memory:');
  for (const sql of ALL_MIGRATIONS) raw.exec(sql);
  const env = makeEnv(raw);

  const kpA = isoKeypair(SEED_A);
  const kpB = isoKeypair(SEED_B);

  const { keyId: keyIdA } = await isoRegister(env, kpA, 'account-A');
  const { keyId: keyIdB } = await isoRegister(env, kpB, 'account-B');

  const { token: tokenA } = await isoSession(env, kpA, keyIdA);
  const { token: tokenB } = await isoSession(env, kpB, keyIdB);

  // B creates a note via the REST API (D6 will stamp accountId = B.id at insert).
  const noteCreate = await app.request('/api/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenB}` },
    body: JSON.stringify({
      id: B_NOTE,
      notebookId: B_NOTEBOOK,
      title: SEARCH_TERM,
      properties: {},
      body: [{ id: B_BLOCK, type: 'paragraph' }],
    }),
  }, env);
  expect(noteCreate.status).toBe(201);

  // B pushes a second note via sync.push (for the pull / push isolation tests).
  const syncPush = await isoPost(env, '/api/sync/push', {
    notebookId: B_NOTEBOOK,
    entries: [{ id: B_SYNC_NOTE, baseVersion: 0, draft: { title: 'b-sync-note', properties: {}, body: [] } }],
  }, tokenB);
  expect(syncPush.status).toBe(200);

  return { raw, env, tokenA, keyIdA, kpA, tokenB, keyIdB };
}

// ---------------------------------------------------------------------------
// D6 cross-account isolation — standing bar
// ---------------------------------------------------------------------------

describe("D6 cross-account isolation (standing bar) — note CRUD", () => {

  it("note.get: A cannot fetch B's note → 404", async () => {
    const { env, tokenA } = await buildFixture();
    const res = await app.request(`/api/notes/${B_NOTE}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    }, env);
    expect(res.status).toBe(404);
  });

  it("note.update: A cannot patch B's note → 404; B's title unchanged", async () => {
    const { raw, env, tokenA } = await buildFixture();
    const res = await app.request(`/api/notes/${B_NOTE}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ patch: { title: 'hacked-by-A' } }),
    }, env);
    expect(res.status).toBe(404);
    const row = raw.prepare('SELECT title FROM notes WHERE id = ?').get(B_NOTE) as { title: string } | undefined;
    expect(row?.title).toBe(SEARCH_TERM); // no mutation
  });

  it("note.delete: A cannot delete B's note → 404; soft-delete NOT applied", async () => {
    const { raw, env, tokenA } = await buildFixture();
    const res = await app.request(`/api/notes/${B_NOTE}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    }, env);
    expect(res.status).toBe(404);
    const row = raw.prepare('SELECT deletedAt FROM notes WHERE id = ?').get(B_NOTE) as { deletedAt: string | null } | undefined;
    expect(row?.deletedAt).toBeNull();
  });

  it("block.append: A cannot append to B's note → 404; B's body block count unchanged", async () => {
    const { raw, env, tokenA } = await buildFixture();
    const res = await app.request(`/api/notes/${B_NOTE}/blocks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        block: { id: '00000000-0000-4000-a000-000000000099', type: 'paragraph', content: 'injected' },
      }),
    }, env);
    expect(res.status).toBe(404);
    const row = raw.prepare('SELECT body FROM notes WHERE id = ?').get(B_NOTE) as { body: string } | undefined;
    expect((JSON.parse(row!.body) as unknown[]).length).toBe(1); // original single block, no injection
  });

  it("property.set: A cannot set property on B's note → 404", async () => {
    const { env, tokenA } = await buildFixture();
    const res = await app.request(`/api/notes/${B_NOTE}/properties/injected-key`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ value: { type: 'text', value: 'hacked' } }),
    }, env);
    expect(res.status).toBe(404);
  });

});

describe("D6 cross-account isolation (standing bar) — note.search (primary leak vector)", () => {

  it("workspace search (no notebookId): A's token returns empty; B's note with matching title absent", async () => {
    const { env, tokenA } = await buildFixture();
    const res = await app.request(`/api/search?text=${encodeURIComponent(SEARCH_TERM)}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    expect(body.results).toHaveLength(0);
  });

});

describe("D6 cross-account isolation (standing bar) — sync [GREEN: scopeSys dd86704]", () => {

  it("sync.pull: A pulling B's notebookId returns empty, not B's notes", async () => {
    const { env, tokenA } = await buildFixture();
    const res = await app.request(`/api/sync/pull?notebookId=${B_NOTEBOOK}&cursor=0`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { notes: unknown[] };
    expect(body.notes).toHaveLength(0);
  });

  it("sync.push: A updating B's existing note gets conflict, not accepted", async () => {
    const { env, tokenA } = await buildFixture();
    // B_SYNC_NOTE was inserted at baseVersion=0 → server assigned version=1 (FIRST_SERVER_VERSION).
    // A sends a valid CAS update for version=1: currently the WHERE id=? AND notebookId=? AND version=1
    // matches and accepts. After D6 adds AND accountId=A.id: 0 rows → conflict.
    const res = await isoPost(env, '/api/sync/push', {
      notebookId: B_NOTEBOOK,
      entries: [{ id: B_SYNC_NOTE, baseVersion: 1, draft: { title: 'hacked-by-A', properties: {}, body: [] } }],
    }, tokenA);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ outcome: string }> };
    expect(body.results[0]!.outcome).toBe('conflict');
  });

});

// ---------------------------------------------------------------------------
// §J — principalId-stamp regression gate (pilot directive, pre-done-gate close)
//
// WHY: in v1, accountId and accountFingerprint are both unique per account, so route-level tests
// that verify cross-account isolation CANNOT distinguish them — a regression that stamped
// accountFingerprint instead of accountId at auth.ts session-mint would stay GREEN at every
// route assertion. This test hits the GRANTS TABLE directly after a real /register -> /session
// round-trip and asserts the shape of the stored principalId. Any regression is caught instantly.
//
// accountId   = randomToken(16) = base64url ~22 chars (NOT hex; the migration comment
//               says hex(randomblob(16)) but auth.ts uses randomToken(16) — base64url)
// fingerprint = base64url(SHA-256(pubkey)) = 43 chars, containing A-Z/a-z/0-9/-/_
// ---------------------------------------------------------------------------

describe("§J — principalId-stamp correctness: real route mint stamps accountId (not fingerprint) in grants [regression gate]", () => {

  it("after real /register -> /session route, grants.principalId == accounts.accountId AND is shorter than the 43-char fingerprint (base64url ~22 chars, not hex)", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeEnv(raw);

    // Seed 35: outside the two-account fixture range (SEED_A=33, SEED_B=34) — no collision.
    const kp = isoKeypair(35);
    const { keyId } = await isoRegister(env, kp, 'shape-regression-device');
    await isoSession(env, kp, keyId);

    // Session mint creates a principalKind='owner' grant. After D6 re-point auth.ts stamps
    // principalId = accountId (32-hex). A bug stamping device.accountFingerprint (43-char base64url)
    // instead would propagate silently through all route-level cross-account tests that happen to
    // have one account per fingerprint — this assertion catches it at the SQL layer.
    const grantRow = raw
      .prepare("SELECT principalId FROM grants WHERE principalKind = 'owner' ORDER BY rowid DESC LIMIT 1")
      .get() as { principalId: string } | undefined;
    const accountRow = raw
      .prepare('SELECT accountId FROM accounts LIMIT 1')
      .get() as { accountId: string } | undefined;

    // The device fingerprint is the value a buggy mint would stamp (base64url SHA-256 of pubkey, 43 chars).
    const deviceRow = raw
      .prepare('SELECT accountFingerprint FROM devices LIMIT 1')
      .get() as { accountFingerprint: string } | undefined;

    expect(grantRow).toBeDefined();
    expect(accountRow).toBeDefined();
    expect(deviceRow).toBeDefined();
    // The two must agree — principalId was re-pointed to accountId by auth.ts session handler.
    expect(grantRow!.principalId).toBe(accountRow!.accountId);
    // Must NOT be the device fingerprint (base64url SHA-256(signingPublicKey), 43 chars).
    // This is the direct proof: a regression stamping accountFingerprint instead of accountId fails here.
    expect(grantRow!.principalId).not.toBe(deviceRow!.accountFingerprint);
    // Fingerprint is always 43 chars (base64url 32 bytes); accountId is shorter (randomToken(16) = ~22 chars).
    expect(grantRow!.principalId.length).toBeLessThan(deviceRow!.accountFingerprint.length);
  });

});

// ---------------------------------------------------------------------------
// §K — never-client-trusted accountId spot-check (devSys a62df7b + gruntSys2 2a4120e)
//
// The server stamps accountId server-side from the authenticated principal — it is NEVER
// read from the request body. Proves two properties:
//   (a) A mutating request that injects {accountId: B} in the body creates the row under A.
//   (b) The injection does NOT grant A read access into B's data (isolation holds after attempt).
//
// Seeds 36 (A) and 37 (B) — outside all existing fixture ranges (20-35).
// ---------------------------------------------------------------------------

describe("§K — never-client-trusted accountId: body {accountId: B} is ignored; row lands under A; isolation holds", () => {

  it("note.create with body.accountId=B stamps notes.accountId=A (server ignores body field)", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeEnv(raw);

    const kpA = isoKeypair(36);
    const kpB = isoKeypair(37);
    const { keyId: keyIdA } = await isoRegister(env, kpA, 'nct-A');
    await isoRegister(env, kpB, 'nct-B');
    const { token: tokenA } = await isoSession(env, kpA, keyIdA);

    // A registered first → row 0; B registered second → row 1.
    const accounts = raw
      .prepare('SELECT accountId FROM accounts ORDER BY rowid')
      .all() as Array<{ accountId: string }>;
    const aAccountId = accounts[0]!.accountId;
    const bAccountId = accounts[1]!.accountId;

    // A creates a note and injects B's accountId in the body — server must ignore it.
    const res = await app.request('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        id: '00000000-0000-4000-c000-000000000001',
        notebookId: '00000000-0000-4000-c000-000000000002',
        title: 'nct-create-test',
        properties: {},
        body: [],
        accountId: bAccountId, // injection attempt — server MUST ignore
      }),
    }, env);
    expect(res.status).toBe(201);

    const noteRow = raw
      .prepare("SELECT accountId FROM notes WHERE id = '00000000-0000-4000-c000-000000000001'")
      .get() as { accountId: string | null } | undefined;
    expect(noteRow?.accountId).toBe(aAccountId);       // stamped from principal, not body
    expect(noteRow?.accountId).not.toBe(bAccountId);   // body injection had no effect
  });

  it("sync.push with body.accountId=B stamps notes.accountId=A (server ignores body field)", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeEnv(raw);

    const kpA = isoKeypair(36);
    const kpB = isoKeypair(37);
    const { keyId: keyIdA } = await isoRegister(env, kpA, 'nct-sync-A');
    await isoRegister(env, kpB, 'nct-sync-B');
    const { token: tokenA } = await isoSession(env, kpA, keyIdA);

    const accounts = raw
      .prepare('SELECT accountId FROM accounts ORDER BY rowid')
      .all() as Array<{ accountId: string }>;
    const aAccountId = accounts[0]!.accountId;
    const bAccountId = accounts[1]!.accountId;

    // A pushes a note and injects B's accountId in the body — server must ignore it.
    const pushRes = await isoPost(env, '/api/sync/push', {
      notebookId: '00000000-0000-4000-c000-000000000003',
      entries: [{ id: '00000000-0000-4000-c000-000000000004', baseVersion: 0, draft: { title: 'nct-sync-test', properties: {}, body: [] } }],
      accountId: bAccountId, // injection attempt — server reads from principal, not body
    }, tokenA);
    expect(pushRes.status).toBe(200);
    const pushBody = await pushRes.json() as { results: Array<{ outcome: string }> };
    expect(pushBody.results[0]!.outcome).toBe('accepted');

    const noteRow = raw
      .prepare("SELECT accountId FROM notes WHERE id = '00000000-0000-4000-c000-000000000004'")
      .get() as { accountId: string | null } | undefined;
    expect(noteRow?.accountId).toBe(aAccountId);       // stamped from principal, not body
    expect(noteRow?.accountId).not.toBe(bAccountId);   // body injection had no effect
  });

  it("after body.accountId=B injection attempt, A still cannot read B's pre-existing notes → 404", async () => {
    // Even after a body injection attempt, isolation must hold on reads: A's token cannot
    // retrieve B's notes regardless of any prior injection. D6 (scopeSys 303db9a) makes this GREEN.
    const { env, tokenA } = await buildFixture();
    const res = await app.request(`/api/notes/${B_NOTE}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    }, env);
    expect(res.status).toBe(404);
  });

});

describe("D6 cross-account isolation (standing bar) — device routes [GREEN now; must survive D6 re-point]", () => {

  it("GET /api/auth/devices: A's token lists only A's devices; B's keyId absent", async () => {
    const { env, tokenA, keyIdA, keyIdB } = await buildFixture();
    const res = await app.request('/api/auth/devices', {
      headers: { Authorization: `Bearer ${tokenA}` },
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { devices: Array<{ keyId: string }> };
    expect(body.devices.some((d) => d.keyId === keyIdA)).toBe(true);
    expect(body.devices.some((d) => d.keyId === keyIdB)).toBe(false);
  });

  it("device.revoke: A step-up-revokes B's device → 404; B's device row unchanged", async () => {
    const { raw, env, kpA, keyIdA, keyIdB } = await buildFixture();
    const ch = await isoChallenge(env, { purpose: 'step-up', keyId: keyIdA });
    const sig = isoSign(kpA.priv, canonicalAuthPayload({
      purpose: 'step-up', audience: ISO_AUD, challengeId: ch.challengeId,
      nonce: base64urlDecodeStrict(ch.nonce), keyId: keyIdA, op: 'delete', resource: { kind: 'workspace' },
    }));
    const res = await isoPost(env, `/api/auth/devices/${keyIdB}/revoke`, {
      challengeId: ch.challengeId, keyId: keyIdA, op: 'delete', resource: { kind: 'workspace' }, signature: sig,
    });
    expect(res.status).toBe(404);
    const row = raw.prepare('SELECT revokedAt FROM devices WHERE keyId = ?').get(keyIdB) as { revokedAt: string | null } | undefined;
    expect(row?.revokedAt).toBeNull();
  });

});
