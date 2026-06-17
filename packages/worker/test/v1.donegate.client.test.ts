/**
 * v1 DONE-GATE — TIER A: headless client suite (automatable [CLI-auto] half).
 *
 * The client SIBLING of v1.donegate.test.ts ([SRV]), co-located in the worker test pkg so the whole
 * done-gate lives in one package (scopeSys ruling 282cca7) and the sync legs can drive the REAL
 * client syncEngine against the REAL worker Hono app (fetch → app.request, over better-sqlite3 +
 * migrations 0000-0003). Tier B = on-device iPhone dogfood (planSys runbook 282cca7), NOT here.
 *
 * Single-editor: devSys2. Client-lane scenario specs (DG-1b/2b/3d-F7) from gruntSys2; sync/editor
 * scenarios (DG-2d/3d-header/3e + the sync-e2e DG-3a/2c/5c-echo) are mine.
 *
 * Coverage: DG-1b enrollNew/enrollExisting determinism · DG-2b offline persistence LOGIC ·
 * DG-2d block-id stability · DG-3d auth-header + F7 token-never-at-rest · DG-3e sync-indicator ·
 * DG-3a sync round-trip · DG-2c offline reconcile · DG-5c-echo cross-account isolation.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import {
  canonicalAuthPayload,
  base64urlEncode,
  base64urlDecodeStrict,
  type Scope,
  type Note,
} from '@deltos/shared';
import { syncNow, getSyncState, subscribeSyncState } from '@deltos/client/src/lib/syncEngine.js';
import { mutateNotes } from '@deltos/client/src/db/mutate.js';
import { db as clientDb } from '@deltos/client/src/db/schema.js';
import { useAuthStore } from '@deltos/client/src/auth/store.js';
import app from '../src/index.js';
import type { Env } from '../src/env.js';

if (!ed.hashes.sha512) ed.hashes.sha512 = sha512;

// --- resolution sanity (probe): cross-package + worker-app imports must resolve under vitest ---
describe('Tier-A harness wiring', () => {
  it('resolves @deltos/client source imports + the worker app from the worker test pkg', () => {
    expect(typeof syncNow).toBe('function');
    expect(typeof getSyncState).toBe('function');
    expect(typeof mutateNotes.put).toBe('function');
    expect(typeof useAuthStore.getState).toBe('function');
    expect(typeof app.request).toBe('function');
  });
});

// DG-1b — enroll determinism (mnemonic re-derives the same identity) is RETIRED by the 2026-06-17
// auth pivot: client-side key derivation is gone (the recovery phrase is now a server-side Argon2id
// reset verifier, not a crypto root). Its successor lives in scopeSys's auth-pivot acceptance matrix
// (register/recovery semantics, AP-*), exercised against the worker password handlers — not here.

// ---------------------------------------------------------------------------
// SYNC-E2E infrastructure — the REAL client syncEngine driven against the REAL worker app.
// global.fetch is bridged to app.request(path, init, env), so a client push/pull runs through the
// actual Hono routes + can() chokepoint + better-sqlite3 D1 (migrations 0000-0003). (Helpers
// mirror v1.donegate.test.ts — test files can't import each other.)
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = ['0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql'].map(
  (f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'),
);
const DG_AUD = 'deltos.v1.donegate';

function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      sql,
      _params: [] as unknown[],
      bind(...p: unknown[]) { stmt._params = p; return stmt; },
      async first<T>() { return (raw.prepare(sql).get(...(stmt._params as never[])) ?? null) as T | null; },
      async all<T>() { return { results: raw.prepare(sql).all(...(stmt._params as never[])) as T[] }; },
      async run() { const i = raw.prepare(sql).run(...(stmt._params as never[])); return { meta: { rows_written: i.changes } }; },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(prepared: Array<{ sql: string; _params: unknown[] }>) {
      return prepared.map((s) => { const i = raw.prepare(s.sql).run(...(s._params as never[])); return { meta: { rows_written: i.changes } }; });
    },
  } as unknown as D1Database;
}

const makeEnv = (raw: Database.Database): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: DG_AUD } as unknown as Env);

function dgKeypair(seed: number) {
  const priv = new Uint8Array(32).fill(seed);
  const pub = ed.getPublicKey(priv);
  return { priv, pub, pubB64: base64urlEncode(pub) };
}
const dgSign = (priv: Uint8Array, msg: Uint8Array) => base64urlEncode(ed.sign(msg, priv));
const dgPost = (env: Env, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);

async function dgChallenge(env: Env, body: unknown) {
  const res = await dgPost(env, '/api/auth/challenge', body);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ challengeId: string; nonce: string }>;
}
async function dgRegister(env: Env, kp: ReturnType<typeof dgKeypair>, label: string) {
  const ch = await dgChallenge(env, { purpose: 'register' });
  const sig = dgSign(kp.priv, canonicalAuthPayload({
    purpose: 'register', audience: DG_AUD, challengeId: ch.challengeId,
    nonce: base64urlDecodeStrict(ch.nonce), signingPublicKey: kp.pub, deviceLabel: label,
  }));
  const res = await dgPost(env, '/api/auth/register', { challengeId: ch.challengeId, signingPublicKey: kp.pubB64, deviceLabel: label, signature: sig });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ keyId: string }>;
}
async function dgSession(env: Env, kp: ReturnType<typeof dgKeypair>, keyId: string) {
  const scope: Scope[] = ['read', 'write', 'create', 'delete', 'search'];
  const ch = await dgChallenge(env, { purpose: 'session', keyId });
  const sig = dgSign(kp.priv, canonicalAuthPayload({
    purpose: 'session', audience: DG_AUD, challengeId: ch.challengeId,
    nonce: base64urlDecodeStrict(ch.nonce), keyId, requestedScope: scope,
  }));
  const res = await dgPost(env, '/api/auth/session', { challengeId: ch.challengeId, keyId, requestedScope: scope, signature: sig });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ token: string }>;
}
/** Enroll a fresh account against the worker app; returns its bearer token + keyId. */
async function dgEnroll(env: Env, seed: number) {
  const kp = dgKeypair(seed);
  const { keyId } = await dgRegister(env, kp, `device-${seed}`);
  const { token } = await dgSession(env, kp, keyId);
  return { token, keyId, kp };
}

const DG_NB = '00000000-0000-4000-d000-0000000000c1';
const clientNote = (id: string, title: string, body: unknown[] = [], version = 0): Note =>
  ({ id, notebookId: DG_NB, title, properties: {}, body, version, createdAt: '2026-06-16T00:00:00.000Z', updatedAt: '2026-06-16T00:00:00.000Z', syncStatus: 'local-only' } as unknown as Note);

const bridgeLog: Array<{ path: string; auth: string | undefined; status: number }> = [];
let lsStore: Record<string, string> = {};
/** Route the client engine's fetch → the worker app over `env`; stub localStorage (cursor/keyId). */
function bridge(env: Env) {
  bridgeLog.length = 0;
  lsStore = {};
  global.localStorage = {
    getItem: (k: string) => lsStore[k] ?? null,
    setItem: (k: string, v: string) => { lsStore[k] = v; },
    removeItem: (k: string) => { delete lsStore[k]; },
  } as unknown as Storage;
  global.fetch = (async (input: string | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const path = raw.startsWith('http') ? new URL(raw).pathname + new URL(raw).search : raw;
    const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
    const res = await app.request(path, init, env);
    bridgeLog.push({ path, auth, status: res.status });
    return res;
  }) as typeof fetch;
}
const settle = () => new Promise((r) => setTimeout(r, 60));

let env: Env;
beforeEach(async () => {
  const raw = new Database(':memory:');
  for (const m of ALL_MIGRATIONS) raw.exec(m);
  env = makeEnv(raw);
  await Promise.all([clientDb.notes.clear(), clientDb.syncQueue.clear(), clientDb.notebooks.clear()]);
  useAuthStore.setState({ bearerToken: null });
  bridge(env);
});

// ---------------------------------------------------------------------------
// DG-3a — authenticated sync round-trip: create offline → syncNow → server has it + local synced.
// Drives the REAL client engine (push+pull through the bridge) with a REAL bearer. [PIN-SYNC-1/2]
// ---------------------------------------------------------------------------

describe('DG-3a — authenticated sync round-trip (client engine ↔ worker)', () => {
  it('a note created offline is pushed under the account and returns byte-identical on pull', async () => {
    const { token } = await dgEnroll(env, 11);
    useAuthStore.setState({ bearerToken: token });

    const BLOCK = '00000000-0000-4000-8000-0000000000b1';
    const note = clientNote('00000000-0000-4000-d000-00000000a001', 'Round-trip note', [{ type: 'paragraph', id: BLOCK, content: 'hello' }]);
    await mutateNotes.put(note); // offline create → queued
    syncNow(DG_NB, '/api');
    await settle();

    // Local store: the engine confirmed the push (version bumped, synced).
    const local = await clientDb.notes.get(note.id);
    expect(getSyncState()).toBe('idle'); // clean round-trip, no error/offline
    expect(local?.syncStatus).toBe('synced');
    expect(local?.version).toBe(1);

    // Server view (raw pull with the same bearer): the note is present + content byte-identical.
    const res = await app.request(`/api/sync/pull?notebookId=${DG_NB}&cursor=0`, { headers: { Authorization: `Bearer ${token}` } }, env);
    expect(res.status).toBe(200);
    const { notes } = (await res.json()) as { notes: Array<{ id: string; title: string; body: unknown[] }> };
    const server = notes.find((n) => n.id === note.id);
    expect(server).toBeDefined();
    expect(server!.title).toBe(note.title);
    expect(server!.body).toEqual(note.body); // byte-identical round-trip of the block body
  });

  it('DG-3d: every sync request the engine issues carries Authorization: Bearer <token>', async () => {
    const { token } = await dgEnroll(env, 12);
    useAuthStore.setState({ bearerToken: token });
    await mutateNotes.put(clientNote('00000000-0000-4000-d000-00000000a002', 'Auth header note'));
    syncNow(DG_NB, '/api');
    await settle();

    const syncReqs = bridgeLog.filter((r) => r.path.startsWith('/api/sync/'));
    expect(syncReqs.length).toBeGreaterThan(0);
    for (const r of syncReqs) expect(r.auth).toBe(`Bearer ${token}`); // push AND pull authenticated
  });
});

// ---------------------------------------------------------------------------
// DG-2c — offline create→edit reconciliation through the engine: each push accepted, version
// bumps monotonically, pull returns the final state. [PIN-SYNC-1]
// ---------------------------------------------------------------------------

describe('DG-2c — offline create/edit reconciliation (client engine)', () => {
  it('a create then an edit each push accepted with version increments; final state is the edit', async () => {
    const { token } = await dgEnroll(env, 13);
    useAuthStore.setState({ bearerToken: token });
    const id = '00000000-0000-4000-d000-00000000a003';

    await mutateNotes.put(clientNote(id, 'v1 title'));
    syncNow(DG_NB, '/api');
    await settle();
    const after1 = await clientDb.notes.get(id);
    expect(after1?.version).toBe(1); // create accepted at v1

    // Offline edit on top of the confirmed version → queues at baseVersion=1.
    await mutateNotes.put({ ...(after1 as Note), title: 'v2 title' });
    syncNow(DG_NB, '/api');
    await settle();
    const after2 = await clientDb.notes.get(id);
    expect(after2?.version).toBe(2); // edit accepted via CAS → v2
    expect(after2?.syncStatus).toBe('synced');
    expect(after2?.title).toBe('v2 title');

    // Server pull reflects the final edit.
    const res = await app.request(`/api/sync/pull?notebookId=${DG_NB}&cursor=0`, { headers: { Authorization: `Bearer ${token}` } }, env);
    const { notes } = (await res.json()) as { notes: Array<{ id: string; title: string }> };
    expect(notes.find((n) => n.id === id)?.title).toBe('v2 title');
  });
});

// ---------------------------------------------------------------------------
// DG-5c-echo — cross-account isolation at the CLIENT engine: account B's pull never returns
// account A's notes. (Server-authoritative isolation is isolation.acceptance.test.ts 10/10; this is
// the engine-level echo, not a replacement.) [D6 accountId]
// ---------------------------------------------------------------------------

describe('DG-5c-echo — cross-account isolation (client engine pull)', () => {
  it("account B's engine pull does not surface account A's synced note", async () => {
    // A creates + syncs a note.
    const a = await dgEnroll(env, 14);
    useAuthStore.setState({ bearerToken: a.token });
    const aNote = '00000000-0000-4000-d000-00000000a004';
    await mutateNotes.put(clientNote(aNote, "A's private note"));
    syncNow(DG_NB, '/api');
    await settle();

    // B (a distinct account) starts fresh and pulls the SAME notebookId via the engine.
    const b = await dgEnroll(env, 15);
    await Promise.all([clientDb.notes.clear(), clientDb.syncQueue.clear()]);
    global.localStorage.removeItem(`deltos.sync.cursor.v1.${DG_NB}`); // fresh cursor for B
    useAuthStore.setState({ bearerToken: b.token });
    syncNow(DG_NB, '/api');
    await settle();

    // B's local store never received A's note (server scoped the pull by B's accountId).
    expect(await clientDb.notes.get(aNote)).toBeUndefined();
    expect(await clientDb.notes.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DG-3d (F7) — the ACCESS (bearer) token is IN-MEMORY ONLY, never persisted at rest. The auth pivot
// keeps this invariant: the access token lives only in the store (set via the password actions /
// cold-boot refresh); the durable credential is the httpOnly refresh COOKIE, which JS can't read and
// is never in localStorage. The headless test asserts the store's persistence invariant; logout()
// clears the in-memory token. The on-device capstone exercises the full ceremony.
// Spec: gruntSys2. [[auth-pivot-security-model]]
// ---------------------------------------------------------------------------

describe('DG-3d (F7) — token in-memory only, never at rest', () => {
  it('a set bearerToken is never written to localStorage; logout() clears it', async () => {
    const TOKEN = 'secret-grant-token-zzz';
    useAuthStore.setState({ bearerToken: TOKEN, accountId: 'acct-f7' });
    expect(useAuthStore.getState().bearerToken).toBe(TOKEN); // in-memory is fine

    expect(Object.values(lsStore).some((v) => v.includes(TOKEN))).toBe(false); // not at rest
    expect(lsStore['bearerToken']).toBeUndefined();

    await useAuthStore.getState().logout(); // clears the in-memory session (locally, even if the net call fails)
    expect(useAuthStore.getState().bearerToken).toBeNull();
    expect(Object.values(lsStore).some((v) => v.includes(TOKEN))).toBe(false); // still not at rest
  });
});

// ---------------------------------------------------------------------------
// DG-2b — offline create/edit persists to the local store; survives a connection reopen (LOGIC;
// true persistence-across-reload/PWA-reinstall stays on-device per scopeSys). Spec: gruntSys2.
// ---------------------------------------------------------------------------

describe('DG-2b — offline persistence (local store logic)', () => {
  it('a note created/edited offline persists in IndexedDB, survives a db reopen, queues each edit', async () => {
    const id = '00000000-0000-4000-d000-00000000a005';

    await mutateNotes.put(clientNote(id, 'offline note')); // NO network
    expect((await clientDb.notes.get(id))?.title).toBe('offline note');
    expect((await clientDb.syncQueue.toArray()).some((e) => e.recordId === id)).toBe(true);

    // "Reload": drop + reopen the IDB connection → the note is restored from IndexedDB (not memory).
    clientDb.close();
    await clientDb.open();
    expect((await clientDb.notes.get(id))?.title).toBe('offline note');

    // Edit updates in place (old title gone); a fresh queue entry is enqueued.
    await mutateNotes.put({ ...((await clientDb.notes.get(id)) as Note), title: 'edited offline' });
    expect((await clientDb.notes.get(id))?.title).toBe('edited offline');
    expect((await clientDb.syncQueue.toArray()).filter((e) => e.recordId === id).length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// DG-3e — sync-indicator state model: idle → syncing → idle on a clean cycle; offline on a network
// failure; error on a non-network failure. [Stream B acceptance]
// ---------------------------------------------------------------------------

describe('DG-3e — sync-indicator state model', () => {
  it('a clean sync cycle settles to idle and notifies subscribers', async () => {
    const { token } = await dgEnroll(env, 16);
    useAuthStore.setState({ bearerToken: token });
    const seen: string[] = [];
    const unsub = subscribeSyncState((s) => seen.push(s));

    await mutateNotes.put(clientNote('00000000-0000-4000-d000-00000000a006', 'indicator note'));
    syncNow(DG_NB, '/api');
    await settle();
    unsub();

    expect(seen).toContain('syncing'); // went through syncing
    expect(getSyncState()).toBe('idle'); // settled clean
  });

  it('reaches offline on a network failure and error on a non-network failure', async () => {
    useAuthStore.setState({ bearerToken: 'tok' });

    // offline: a fetch TypeError mentioning "fetch" maps to the offline state.
    global.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    await mutateNotes.put(clientNote('00000000-0000-4000-d000-00000000a007', 'offline test'));
    syncNow(DG_NB, '/api');
    await settle();
    expect(getSyncState()).toBe('offline');

    // error: any other thrown error maps to the error state.
    global.fetch = (async () => { throw new Error('boom'); }) as typeof fetch;
    await mutateNotes.put(clientNote('00000000-0000-4000-d000-00000000a008', 'error test'));
    syncNow(DG_NB, '/api');
    await settle();
    expect(getSyncState()).toBe('error');
  });
});
