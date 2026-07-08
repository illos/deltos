/**
 * v1 done-gate harness — server slice.
 *
 * This file IS "done." Each scenario is RED until the listed integration gap is closed;
 * going fully GREEN is the v1 ship signal. Pilot uses the RED count as the distance-to-v1.
 *
 * SERVER SCOPE (this file): enroll, note CRUD, authenticated sync push/pull, 2nd-device
 * recovery, auth gating, principalId accountId-stability.
 *
 * CLIENT SCOPE (out of this harness — marked [CLI] in the done-gate checklist):
 *   install / PWA manifest, passkey-unlock UI, true offline IndexedDB persistence,
 *   QR-join / cross-device invite, editor block-id round-trips.
 *
 * Acceptance checklist: docs/specs/v1-done-gate-acceptance-checklist.md
 *   DG-1  enroll              → DGT-1 + DGT-5 (capstone)
 *   DG-2  offline reconcile   → DGT-3
 *   DG-3  authenticated sync  → DGT-1
 *   DG-4  2nd-device recovery → DGT-2 + DGT-5 (capstone)
 *   DG-5  auth gating         → DGT-4
 *   DG-CAP note-present       → DGT-5
 *
 * Cross-account isolation is proved by isolation.acceptance.test.ts (DG-5c reference, no dup).
 *
 * Gap list (updated by secSys as scenarios flip):
 *   DGT-2 RED: register route must allow same signing key → 2nd device in same account
 *              (resolveAccountIdByFingerprint path + no double-bind on existing fingerprint).
 *   DGT-3 RED: CAS baseVersion semantics + sync.pull cursor round-trip needs verification.
 *   DGT-5 RED: capstone = DGT-1 + DGT-2 combined; goes GREEN when both legs are GREEN.
 *   DGT-1, DGT-4: expected GREEN (auth + sync already wired); confirm on first run.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { signupToken } from './helpers/passwordToken.js';
import { allMigrations } from './helpers/migrations.js';

// ---------------------------------------------------------------------------
// Infrastructure (duplicated from isolation.acceptance.test.ts — test files cannot import each other)
//
// AUTH PIVOT (2026-06-17): the done-gate token-mint moved from signed-challenge register+session to
// password /signup (+ /login for the "2nd device" = a 2nd login of the SAME username+password →
// SAME accountId). The sync / CAS / auth-gating assertions are credential-agnostic and unchanged.
// The retired device-determinism legs (distinct-keyId per registration, device→account fingerprint
// stamp) were removed with the signed-challenge stack — "2nd-device recovery" is now proved by a 2nd
// login resolving to the same account, the password-world analog of same-signing-key recovery.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = allMigrations();

const DG_AUD = 'deltos.v1.donegate';

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
    AUTH_AUDIENCE: DG_AUD,
    AUTH_PEPPER: 'donegate-test-pepper',
  } as unknown as Env);

// Production env: F13 tripwire active — unverified principals (no/invalid bearer) return 503 instead
// of being allowed through as the dev stub. Used only in DGT-4 auth-gating tests. (AUTH_PEPPER set so
// the one prod-env test that first creates a note via /signup can mint a token.)
const makeProdEnv = (raw: Database.Database): Env =>
  ({
    DB: d1Over(raw),
    ENVIRONMENT: 'production',
    AUTH_AUDIENCE: DG_AUD,
    AUTH_PEPPER: 'donegate-test-pepper',
  } as unknown as Env);

const dgPost = (env: Env, path: string, body: unknown, token?: string) =>
  app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }, env);

// The canonical done-gate password account. A 2nd "device" = a 2nd /login of the SAME credential,
// which resolves to the SAME accountId (the password-world analog of same-signing-key recovery).
const DG_USER = 'dg-user';
const DG_PASS = 'dg-done-gate-password';

/** Sign up the canonical account → { token, accountId }. */
const dgEnroll = (env: Env) => signupToken(env, DG_USER, DG_PASS);

/** A 2nd device = a fresh /login for the same username+password → the SAME account. */
async function dgLogin(env: Env): Promise<{ token: string; accountId: string }> {
  const res = await dgPost(env, '/api/auth/login', { username: DG_USER, password: DG_PASS });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; accountId: string };
  return { token: body.token, accountId: body.accountId };
}

// ---------------------------------------------------------------------------
// Fixture UUIDs — 'd' prefix avoids collision with isolation harness ('b' prefix)
// ---------------------------------------------------------------------------

const DG_NOTEBOOK = '00000000-0000-4000-d000-000000000001';
const DG_NOTE     = '00000000-0000-4000-d000-000000000002';
const DG_NOTE_B   = '00000000-0000-4000-d000-000000000003'; // 2nd note for offline-edit test
const DG_BLOCK    = '00000000-0000-4000-d000-000000000004';
const DG_CONTENT  = 'deltos-v1-done-gate-note-content';

// "2nd-device recovery" is now a 2nd /login of the SAME username+password → SAME accountId.

// ---------------------------------------------------------------------------
// DGT-1 — authenticated sync round-trip
// Proves: enroll → create note via REST → sync.pull returns it byte-identical.
// Gap: expected GREEN (auth + sync wired); confirm on first run.
// ---------------------------------------------------------------------------

describe("DGT-1 — authenticated sync round-trip (enroll → create → pull → note present)", () => {

  it("note created via POST /api/notes is returned by sync.pull with matching title and body", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeEnv(raw);

    const { token } = await dgEnroll(env);

    // Create note via REST (note.create) — stamped with caller's accountId server-side.
    const createRes = await app.request('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: DG_NOTE,
        notebookId: DG_NOTEBOOK,
        title: DG_CONTENT,
        properties: {},
        body: [{ id: DG_BLOCK, type: 'paragraph' }],
      }),
    }, env);
    expect(createRes.status).toBe(201);

    // Pull via sync — authenticated round-trip; same token, same account.
    const pullRes = await app.request(
      `/api/sync/pull?notebookId=${DG_NOTEBOOK}&cursor=0`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(pullRes.status).toBe(200);
    const pullBody = await pullRes.json() as { notes: Array<{ id: string; title: string; body: unknown[] }> };
    const note = pullBody.notes.find((n) => n.id === DG_NOTE);
    expect(note).toBeDefined();
    expect(note!.title).toBe(DG_CONTENT);
    expect(note!.body).toHaveLength(1);
  });

  it("sync.push then sync.pull returns the pushed note (sync-path round-trip)", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeEnv(raw);

    const { token } = await dgEnroll(env);

    const pushRes = await dgPost(env, '/api/sync/push', {
      notebookId: DG_NOTEBOOK,
      entries: [{ id: DG_NOTE, baseVersion: 0, draft: { title: DG_CONTENT, properties: {}, body: [] } }],
    }, token);
    expect(pushRes.status).toBe(200);
    const pushBody = await pushRes.json() as { results: Array<{ id: string; outcome: string; version: number }> };
    expect(pushBody.results[0]!.outcome).toBe('accepted');
    const serverVersion = pushBody.results[0]!.version;

    const pullRes = await app.request(
      `/api/sync/pull?notebookId=${DG_NOTEBOOK}&cursor=0`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(pullRes.status).toBe(200);
    const pullBody = await pullRes.json() as { notes: Array<{ id: string; title: string; version: number }> };
    const note = pullBody.notes.find((n) => n.id === DG_NOTE);
    expect(note).toBeDefined();
    expect(note!.title).toBe(DG_CONTENT);
    expect(note!.version).toBe(serverVersion);
  });

});

// ---------------------------------------------------------------------------
// DGT-2 — 2nd-device recovery (same signing key → same accountId → notes visible)
// Proves: a user enrolling a new device with the same keypair joins the same account and sees
// all prior notes — the D6 accountId-stability guarantee.
// Gap [RED expected]: register route same-key 2nd registration + resolveAccountIdByFingerprint path.
//   Goes GREEN when: auth.ts register resolves existing fingerprint → skips createAccount/bindCredential
//   → creates new device row with same accountFingerprint → session mint → accountId matches.
// ---------------------------------------------------------------------------

describe("DGT-2 — 2nd-device recovery: a 2nd login (same username+password) → same accountId → prior notes visible", () => {

  // The signed-challenge "distinct keyId per registration" leg was RETIRED with the device registry —
  // there are no per-device keyIds under password auth. The account-stability invariant it backstopped
  // (2 logins → EXACTLY ONE account) is reframed below as a 2nd /login resolving to the same accountId.

  it("a 2nd login of the same credential mints a session for the SAME account (one account, same principalId)", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeEnv(raw);

    const a = await dgEnroll(env); // "device A" = signup
    const b = await dgLogin(env);  // "device B" = a 2nd login of the same credential
    expect(b.accountId).toBe(a.accountId); // same account

    // Both sessions stamp the SAME accountId as the grant principalId, and there is EXACTLY ONE account.
    const rows = raw
      .prepare("SELECT principalId FROM grants WHERE principalKind = 'owner' ORDER BY rowid")
      .all() as Array<{ principalId: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.principalId)).size).toBe(1);
    expect((raw.prepare('SELECT COUNT(*) as n FROM accounts').get() as { n: number }).n).toBe(1);
  });

  it("a 2nd login (device B) can pull notes created and synced by the first session (device A)", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeEnv(raw);

    const { token: tokenA } = await dgEnroll(env);

    // A creates note + syncs.
    await dgPost(env, '/api/sync/push', {
      notebookId: DG_NOTEBOOK,
      entries: [{ id: DG_NOTE, baseVersion: 0, draft: { title: DG_CONTENT, properties: {}, body: [] } }],
    }, tokenA);

    // B = a 2nd login (same credential, same account) pulls A's notes.
    const { token: tokenB } = await dgLogin(env);

    const pullRes = await app.request(
      `/api/sync/pull?notebookId=${DG_NOTEBOOK}&cursor=0`,
      { headers: { Authorization: `Bearer ${tokenB}` } },
      env,
    );
    expect(pullRes.status).toBe(200);
    const pullBody = await pullRes.json() as { notes: Array<{ id: string; title: string }> };
    const note = pullBody.notes.find((n) => n.id === DG_NOTE);
    expect(note).toBeDefined();
    expect(note!.title).toBe(DG_CONTENT);
  });

});

// ---------------------------------------------------------------------------
// DGT-3 — offline create/edit reconciliation (server view)
// Proves: batched pushes (new + edits) are accepted with correct CAS semantics;
// pull returns the final state. True offline IndexedDB persistence is CLIENT scope ([CLI]).
// Gap: expected GREEN (CAS logic in mutate.ts wired); confirm on first run.
// ---------------------------------------------------------------------------

describe("DGT-3 — offline create/edit reconciliation (server view)", () => {

  it("push new note (baseVersion=0) → accepted at version=1", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeEnv(raw);

    const { token } = await dgEnroll(env);

    const pushRes = await dgPost(env, '/api/sync/push', {
      notebookId: DG_NOTEBOOK,
      entries: [{ id: DG_NOTE, baseVersion: 0, draft: { title: 'offline-draft', properties: {}, body: [] } }],
    }, token);
    expect(pushRes.status).toBe(200);
    const body = await pushRes.json() as { results: Array<{ outcome: string; version: number }> };
    expect(body.results[0]!.outcome).toBe('accepted');
    expect(body.results[0]!.version).toBeGreaterThan(0);
  });

  it("push edit (baseVersion=server-version) → accepted; pull returns final title", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeEnv(raw);

    const { token } = await dgEnroll(env);

    // Create.
    const push1 = await dgPost(env, '/api/sync/push', {
      notebookId: DG_NOTEBOOK,
      entries: [{ id: DG_NOTE, baseVersion: 0, draft: { title: 'offline-draft-v1', properties: {}, body: [] } }],
    }, token);
    const v1Body = await push1.json() as { results: Array<{ outcome: string; version: number }> };
    expect(v1Body.results[0]!.outcome).toBe('accepted');
    const v1 = v1Body.results[0]!.version;

    // Edit: baseVersion = server version from prior accepted push.
    const push2 = await dgPost(env, '/api/sync/push', {
      notebookId: DG_NOTEBOOK,
      entries: [{ id: DG_NOTE, baseVersion: v1, draft: { title: 'offline-draft-final', properties: {}, body: [] } }],
    }, token);
    expect(push2.status).toBe(200);
    const v2Body = await push2.json() as { results: Array<{ outcome: string; version: number }> };
    expect(v2Body.results[0]!.outcome).toBe('accepted');
    expect(v2Body.results[0]!.version).toBeGreaterThan(v1);

    // Pull → final title.
    const pullRes = await app.request(
      `/api/sync/pull?notebookId=${DG_NOTEBOOK}&cursor=0`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(pullRes.status).toBe(200);
    const pullBody = await pullRes.json() as { notes: Array<{ id: string; title: string }> };
    const note = pullBody.notes.find((n) => n.id === DG_NOTE);
    expect(note).toBeDefined();
    expect(note!.title).toBe('offline-draft-final');
  });

  it("stale CAS push (baseVersion < current) → conflict, not accepted", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeEnv(raw);

    const { token } = await dgEnroll(env);

    // Create at baseVersion=0.
    const push1 = await dgPost(env, '/api/sync/push', {
      notebookId: DG_NOTEBOOK,
      entries: [{ id: DG_NOTE, baseVersion: 0, draft: { title: 'initial', properties: {}, body: [] } }],
    }, token);
    const p1 = await push1.json() as { results: Array<{ outcome: string; version: number }> };
    expect(p1.results[0]!.outcome).toBe('accepted');

    // Concurrent edit: also baseVersion=0 on the same note (stale).
    const push2 = await dgPost(env, '/api/sync/push', {
      notebookId: DG_NOTEBOOK,
      entries: [{ id: DG_NOTE, baseVersion: 0, draft: { title: 'stale-edit', properties: {}, body: [] } }],
    }, token);
    expect(push2.status).toBe(200);
    const p2 = await push2.json() as { results: Array<{ outcome: string }> };
    expect(p2.results[0]!.outcome).toBe('conflict');
  });

});

// ---------------------------------------------------------------------------
// DGT-4 — auth gating (F13 tripwire)
// Proves: unauthenticated / unverified-principal requests are refused in production.
//
// F13 behavior: the guard allows an `unverified` principal ONLY in NON_PROD_ENVIRONMENTS
// (development, test, local). In production, unverified principals return 503 before any
// handler runs. Invalid/missing bearer that fails token lookup returns 401 in all envs.
//
// Gap [no-bearer→503 tests]: expected GREEN (F13 tripwire is implemented). Confirm on first run.
// Gap [invalid-bearer→401]: expected GREEN (resolvePrincipal rejects unknown token). Confirm.
// ---------------------------------------------------------------------------

describe("DGT-4 — auth gating (F13 tripwire): unverified principals refused in production (no bearer → 503)", () => {

  it("POST /api/notes without bearer in production env → 503 (F13 refuses unverified principal)", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeProdEnv(raw);
    const res = await app.request('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: DG_NOTE, notebookId: DG_NOTEBOOK, title: 'unauth', properties: {}, body: [] }),
    }, env);
    expect(res.status).toBe(503);
  });

  it("POST /api/sync/push without bearer in production env → 503", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeProdEnv(raw);
    const res = await dgPost(env, '/api/sync/push', {
      notebookId: DG_NOTEBOOK,
      entries: [{ id: DG_NOTE, baseVersion: 0, draft: { title: 'unauth', properties: {}, body: [] } }],
    });
    expect(res.status).toBe(503);
  });

  it("GET /api/sync/pull without bearer in production env → 503", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeProdEnv(raw);
    const res = await app.request(
      `/api/sync/pull?notebookId=${DG_NOTEBOOK}&cursor=0`,
      {},
      env,
    );
    expect(res.status).toBe(503);
  });

  it("GET /api/notes/:id without bearer in production env → 503 (after note exists)", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    // Create the note in dev env so the row exists — absence of note must not mask the 503.
    const devEnv = makeEnv(raw);
    const { token } = await dgEnroll(devEnv);
    await app.request('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: DG_NOTE, notebookId: DG_NOTEBOOK, title: DG_CONTENT, properties: {}, body: [] }),
    }, devEnv);

    // Switch to prod env — same DB, F13 tripwire active.
    const prodEnv = makeProdEnv(raw);
    const res = await app.request(`/api/notes/${DG_NOTE}`, {}, prodEnv);
    expect(res.status).toBe(503);
  });

  it("invalid bearer (not in grants) → 503 in production env (unrecognized token → unverified principal → F13 refuses)", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    // In dev env, an unrecognized bearer falls back to the unverified stub (allowed — F13 inactive).
    // In production, the same fallback is refused by F13 → 503. The production path is what ships.
    const env = makeProdEnv(raw);
    const res = await dgPost(env, '/api/sync/push', {
      notebookId: DG_NOTEBOOK,
      entries: [{ id: DG_NOTE, baseVersion: 0, draft: { title: 'unauth', properties: {}, body: [] } }],
    }, 'not-a-real-token');
    expect(res.status).toBe(503);
  });

});

// ---------------------------------------------------------------------------
// DGT-5 (capstone) — full v1 journey end-to-end
// enroll → create note → authenticated sync → recover on 2nd device → pull → note present + matches.
// This single test is the "is it done?" signal. Goes GREEN when DGT-1 + DGT-2 are both GREEN.
// Gap [RED expected]: same as DGT-2 (2nd-device recovery path).
// ---------------------------------------------------------------------------

describe("DGT-5 (capstone) — full v1 journey: enroll → create → sync → 2nd-device recover → note present", () => {

  it("note created + synced by device A is present and content-matches on device B (2nd login, same account)", async () => {
    const raw = new Database(':memory:');
    for (const sql of ALL_MIGRATIONS) raw.exec(sql);
    const env = makeEnv(raw);

    // ── Leg 1: enroll device A (signup) ───────────────────────────────────
    const { token: tokenA } = await dgEnroll(env);

    // ── Leg 2: create note via REST + sync push ───────────────────────────
    const createRes = await app.request('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        id: DG_NOTE,
        notebookId: DG_NOTEBOOK,
        title: DG_CONTENT,
        properties: { starred: { type: 'boolean', value: true } },
        body: [{ id: DG_BLOCK, type: 'paragraph', content: 'capstone content' }],
      }),
    }, env);
    expect(createRes.status).toBe(201);
    const createdNote = await createRes.json() as { id: string; title: string; body: unknown[] };

    // Also push a 2nd note via sync to prove the sync path (not just REST).
    await dgPost(env, '/api/sync/push', {
      notebookId: DG_NOTEBOOK,
      entries: [{ id: DG_NOTE_B, baseVersion: 0, draft: { title: 'capstone-sync-note', properties: {}, body: [] } }],
    }, tokenA);

    // ── Leg 3: recover on device B (2nd login of the same credential = same account) ──────
    const { token: tokenB } = await dgLogin(env);

    // B's account must match A's (same username+password → same accountId), and there is one account.
    const grants = raw
      .prepare("SELECT DISTINCT principalId FROM grants WHERE principalKind = 'owner'")
      .all() as Array<{ principalId: string }>;
    expect(grants).toHaveLength(1);

    // ── Leg 4: pull on device B → both notes present, content matches ─────
    const pullRes = await app.request(
      `/api/sync/pull?notebookId=${DG_NOTEBOOK}&cursor=0`,
      { headers: { Authorization: `Bearer ${tokenB}` } },
      env,
    );
    expect(pullRes.status).toBe(200);
    const pullBody = await pullRes.json() as {
      notes: Array<{ id: string; title: string; body: unknown[]; properties: Record<string, unknown> }>;
    };

    // REST-created note present and content-matches.
    const note1 = pullBody.notes.find((n) => n.id === DG_NOTE);
    expect(note1).toBeDefined();
    expect(note1!.title).toBe(createdNote.title);
    expect(note1!.body).toHaveLength(1);

    // Sync-pushed note also present.
    const note2 = pullBody.notes.find((n) => n.id === DG_NOTE_B);
    expect(note2).toBeDefined();
    expect(note2!.title).toBe('capstone-sync-note');
  });

});
