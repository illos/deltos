/**
 * Route-level integration tests for POST /api/sync/push with NOTEBOOK entries (Notebooks #16/#23,
 * closing the secSys #19 route-coverage gap). These guard the push-loop ORDERING invariant (notebooks
 * processed before notes) and the move-target ownership REJECTION at the real HTTP boundary — a unit
 * test on updateNote alone would stay green through a silent handler-order revert; this would not.
 *
 * Self-contained harness (test files can't import each other): better-sqlite3 → D1 shim + the real
 * Hono app + the shared signupToken helper. signup seeds the account's default notebook.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { signupToken } from './helpers/passwordToken.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql',
  '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql',
  '0013_agent-token-label.sql',
  '0014_grant-family-link.sql',].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      sql,
      _params: [] as unknown[],
      bind(...p: unknown[]) { stmt._params = p; return stmt; },
      async first<T>() { return (raw.prepare(sql).get(...(stmt._params as never[])) ?? null) as T | null; },
      async all<T>() { return { results: raw.prepare(sql).all(...(stmt._params as never[])) as T[] }; },
      async run() { const info = raw.prepare(sql).run(...(stmt._params as never[])); return { meta: { rows_written: info.changes } }; },
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

const AUD = 'deltos.notebooks.routes';
const makeEnv = (raw: Database.Database): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, AUTH_PEPPER: 'notebooks-routes-pepper' } as unknown as Env);

const post = (env: Env, path: string, body: unknown, token: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }, env);

const pull = async (env: Env, token: string) => {
  const res = await app.request('/api/sync/pull?cursor=0', { headers: { Authorization: `Bearer ${token}` } }, env);
  return res.json() as Promise<{ notes: Array<{ id: string; notebookId: string; version: number }>; notebooks: Array<{ id: string }> }>;
};

const NOTE = '00000000-0000-4000-e000-000000000001';
const NB_NEW = '00000000-0000-4000-e000-000000000002';
const NB_FOREIGN = '00000000-0000-4000-e000-0000000000ff'; // never owned by the account

describe('POST /api/sync/push — notebook + note batch (route-level, secSys #19 coverage)', () => {
  let env: Env;
  let token: string;

  beforeEach(async () => {
    const raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    ({ token } = await signupToken(env, 'nb-routes-user', 'nb-routes-password'));
  });

  it('same-batch create-notebook-THEN-move-note is ACCEPTED (locks push-loop ordering: notebooks before notes)', async () => {
    // #58: a fresh account has NO notebooks. Insert the note UNCATEGORIZED (no notebookId → All Notes).
    const seeded = await pull(env, token);
    expect(seeded.notebooks).toHaveLength(0);

    // Insert an uncategorized note (note → version 1).
    const ins = await post(env, '/api/sync/push', {
      entries: [{ id: NOTE, baseVersion: 0, draft: { title: 'movable', properties: {}, body: [] } }],
    }, token);
    expect(ins.status).toBe(200);
    expect(((await ins.json()) as { results: Array<{ outcome: string }> }).results[0]!.outcome).toBe('accepted');

    // ONE batch: create NB_NEW + move the note into it. Only passes if notebooks are processed FIRST
    // (the move's ownership check must see NB_NEW already created within this same request).
    const res = await post(env, '/api/sync/push', {
      notebookEntries: [{ id: NB_NEW, baseVersion: 0, draft: { name: 'Project', defaultCollectionView: 'list' } }],
      entries: [{ id: NOTE, notebookId: NB_NEW, baseVersion: 1, draft: { title: 'movable', properties: {}, body: [] } }],
    }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ outcome: string }>;
      notebookResults: Array<{ outcome: string }>;
    };
    expect(body.notebookResults[0]!.outcome).toBe('accepted'); // notebook created
    expect(body.results[0]!.outcome).toBe('accepted'); // move accepted (ordering held)

    const after = await pull(env, token);
    expect(after.notes.find((n) => n.id === NOTE)!.notebookId).toBe(NB_NEW); // landed in the new notebook
  });

  it('move to a FOREIGN / non-owned notebookId is REJECTED at the route (conflict, no orphaning)', async () => {
    // Insert an uncategorized note (#58: no default to seed into).
    await post(env, '/api/sync/push', {
      entries: [{ id: NOTE, baseVersion: 0, draft: { title: 'n', properties: {}, body: [] } }],
    }, token);

    // Move to a notebookId the account does not own / does not exist → rejected.
    const res = await post(env, '/api/sync/push', {
      entries: [{ id: NOTE, notebookId: NB_FOREIGN, baseVersion: 1, draft: { title: 'n', properties: {}, body: [] } }],
    }, token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: Array<{ outcome: string }> }).results[0]!.outcome).toBe('conflict');

    const after = await pull(env, token);
    expect(after.notes.find((n) => n.id === NOTE)!.notebookId).toBeNull(); // stayed uncategorized — not orphaned
  });
});
