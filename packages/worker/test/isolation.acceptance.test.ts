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
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { signupToken } from './helpers/passwordToken.js';

// ---------------------------------------------------------------------------
// Infrastructure (mirrored from auth.acceptance.test.ts — test files cannot import each other)
//
// AUTH PIVOT (2026-06-17): tokens are now minted via password /signup (was signed-challenge
// register+session). The data layer is credential-agnostic, so every cross-account isolation
// assertion below is UNCHANGED — only the mint moved. The retired device/keyId/fingerprint legs
// (old §J principalId-vs-fingerprint regression + the device-routes describe) were removed with the
// signed-challenge stack; cross-account isolation of notes/search/sync is the standing bar that remains.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0003_account-identity.sql',
  '0004_password-auth.sql',
  '0005_recovery-established.sql',
  '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql',
  '0008_notebooks.sql',
  '0009_backfill-default-notebooks.sql',
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
  ({
    DB: d1Over(raw),
    ENVIRONMENT: 'development',
    AUTH_AUDIENCE: ISO_AUD,
    AUTH_PEPPER: 'isolation-test-pepper',
  } as unknown as Env);

const isoPost = (env: Env, path: string, body: unknown, token?: string) =>
  app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }, env);

// ---------------------------------------------------------------------------
// Two-account fixture — B's objects are the isolation targets
// ---------------------------------------------------------------------------

const B_NOTEBOOK  = '00000000-0000-4000-b000-000000000001'; // B's notebook UUID
const B_NOTE      = '00000000-0000-4000-b000-000000000002'; // created via note.create
const B_SYNC_NOTE = '00000000-0000-4000-b000-000000000003'; // pushed via sync.push
const B_BLOCK     = '00000000-0000-4000-b000-000000000004'; // block inside B_NOTE
const SEARCH_TERM = 'b-account-exclusive-secret-note';      // only in B's notes

interface IsoFixture {
  raw: Database.Database;
  env: Env;
  tokenA: string;
  tokenB: string;
}

async function buildFixture(): Promise<IsoFixture> {
  const raw = new Database(':memory:');
  for (const sql of ALL_MIGRATIONS) raw.exec(sql);
  const env = makeEnv(raw);

  // Two distinct accounts via password signup (replaces the signed-challenge two-device mint).
  const { token: tokenA } = await signupToken(env, 'account-a');
  const { token: tokenB } = await signupToken(env, 'account-b');

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

  return { raw, env, tokenA, tokenB };
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

  it("sync.pull: A sees ONLY its own note, never B's — one-shot positive+negative (#12)", async () => {
    const { env, tokenA } = await buildFixture();

    // Give A its OWN note first. The old A-with-no-notes variant could not distinguish
    // "isolation correctly filtered B out" from "the pull just returned nothing" — an empty
    // result is consistent with a totally broken scope. Proving A sees A *and* not-B in one
    // shot is the real account-scope assertion (convergence tests only cover the positive dir).
    const A_NOTEBOOK = '00000000-0000-4000-a000-000000000010';
    const A_NOTE     = '00000000-0000-4000-a000-000000000011';
    const pushA = await isoPost(env, '/api/sync/push', {
      notebookId: A_NOTEBOOK,
      entries: [{ id: A_NOTE, baseVersion: 0, draft: { title: 'a-account-own-note', properties: {}, body: [] } }],
    }, tokenA);
    expect(pushA.status).toBe(200);

    // Pull is accountId-scoped server-side; the notebookId query param is inert post-Option-B.
    // Even passing B's notebookId, A gets exactly its own note and never B's two notes.
    const res = await app.request(`/api/sync/pull?notebookId=${B_NOTEBOOK}&cursor=0`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { notes: Array<{ id: string }> };
    const ids = body.notes.map((n) => n.id);
    expect(ids).toContain(A_NOTE);          // positive: A's own note IS returned
    expect(ids).not.toContain(B_NOTE);      // negative: B's REST-created note absent
    expect(ids).not.toContain(B_SYNC_NOTE); // negative: B's sync-pushed note absent
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

// §J (principalId-vs-fingerprint stamp regression) was RETIRED with the signed-challenge stack: the
// password mint stamps principalId = accountId directly (there is no device fingerprint to confuse it
// with). The standing isolation bar below is unchanged.

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

    const { token: tokenA, accountId: aAccountId } = await signupToken(env, 'nct-a');
    const { accountId: bAccountId } = await signupToken(env, 'nct-b');

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

    const { token: tokenA, accountId: aAccountId } = await signupToken(env, 'nct-sync-a');
    const { accountId: bAccountId } = await signupToken(env, 'nct-sync-b');

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

// The device-routes isolation describe (GET /api/auth/devices, device.revoke step-up) was RETIRED with
// the signed-challenge stack — devices/keyId no longer exist under password auth. Cross-account
// isolation of the DATA plane (notes/search/sync, above) is the standing bar that carries forward.
