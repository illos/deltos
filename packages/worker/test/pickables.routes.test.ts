/**
 * Route + chokepoint tests for the resource-picker data endpoint (ROAD-0011 P1 §1.3):
 * GET /api/account/pickables?q=. This feeds the SEPARATE OAuth consent surface's resource picker (no Dexie
 * there), so the bar mirrors the sibling account routes:
 *   - returns the account's notebooks (LIST select) always, and note MATCHES only when `q` is present
 *     (SEARCH select — search is the note picker);
 *   - note search is the SERVER engine (D1/FTS) — account-scoped;
 *   - account-scoped + BOLA: account B never sees account A's notebooks/notes;
 *   - an AGENT token (no `share`) 403s — a connected AI can't enumerate the owner's notebooks/notes.
 *
 * Self-contained harness: better-sqlite3 → D1 shim + the real Hono app + the shared signupToken helper.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { signupToken } from './helpers/passwordToken.js';
import type { PickablesResponse } from '@deltos/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql',
  '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql', '0013_agent-token-label.sql', '0014_grant-family-link.sql',
  '0015_audit-log.sql', '0016_usage-counter.sql', '0017_oauth-provider.sql', '0018_fts5-note-search.sql',
  '0019_note-routing-guide.sql', '0020_grant-sets.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

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

const AUD = 'deltos.pickables.routes';
const makeEnv = (raw: Database.Database): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, AUTH_PEPPER: 'pickables-pepper' } as unknown as Env);

const get = (env: Env, path: string, token: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${token}` } }, env);

function seedNotebook(raw: Database.Database, id: string, accountId: string, name: string) {
  const iso = new Date().toISOString();
  raw.prepare(
    `INSERT INTO notebooks (id, accountId, name, defaultCollectionView, version, createdAt, updatedAt, deletedAt, syncSeq)
     VALUES (?, ?, ?, 'list', 1, ?, ?, NULL, 0)`,
  ).run(id, accountId, name, iso, iso);
}

/** Insert a note + keep the FTS index current (FTS maintenance is app-code, not a SQL trigger). */
function seedNote(raw: Database.Database, id: string, accountId: string, title: string, notebookId: string | null) {
  const iso = new Date().toISOString();
  raw.prepare(
    `INSERT INTO notes (id, notebookId, title, properties, body, version, createdAt, updatedAt, deletedAt, syncSeq, forkedFromId, accountId)
     VALUES (?, ?, ?, '{}', '[]', 1, ?, ?, NULL, 0, NULL, ?)`,
  ).run(id, notebookId, title, iso, iso, accountId);
  raw.prepare(`INSERT INTO notesFts (title, body, noteId) VALUES (?, '', ?)`).run(title, id);
}

const NB_A1 = '11111111-1111-4111-8111-111111111111';
const NB_A2 = '22222222-2222-4222-8222-222222222222';
const NB_B1 = '33333333-3333-4333-8333-333333333333';
const NOTE_A1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const NOTE_B1 = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

describe('GET /api/account/pickables', () => {
  let env: Env;
  let raw: Database.Database;
  let tokenA: string;
  let accountA: string;

  beforeEach(async () => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    ({ token: tokenA, accountId: accountA } = await signupToken(env, 'picker-owner', 'picker-password'));
  });

  it('returns the account notebooks (LIST) and NO notes when q is absent', async () => {
    seedNotebook(raw, NB_A1, accountA, 'Work');
    seedNotebook(raw, NB_A2, accountA, 'Personal');
    seedNote(raw, NOTE_A1, accountA, 'Grocery list', NB_A1);

    const res = await get(env, '/api/account/pickables', tokenA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PickablesResponse;
    expect(body.notebooks.map((n) => n.name).sort()).toEqual(['Personal', 'Work']);
    expect(body.notes).toEqual([]); // search is the note picker — no q ⇒ no notes
  });

  it('returns matching notes when q is present (server search)', async () => {
    seedNotebook(raw, NB_A1, accountA, 'Work');
    seedNote(raw, NOTE_A1, accountA, 'Grocery list', NB_A1);

    const res = await get(env, '/api/account/pickables?q=grocery', tokenA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PickablesResponse;
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].id).toBe(NOTE_A1);
    expect(body.notes[0].title).toBe('Grocery list');
    expect(body.notes[0].notebookId).toBe(NB_A1);
  });

  it('is account-scoped: account B never sees account A resources', async () => {
    seedNotebook(raw, NB_A1, accountA, 'Work-A');
    seedNote(raw, NOTE_A1, accountA, 'Alpha note', NB_A1);
    const { token: tokenB, accountId: accountB } = await signupToken(env, 'picker-owner-b', 'picker-password-b');
    seedNotebook(raw, NB_B1, accountB, 'Work-B');
    seedNote(raw, NOTE_B1, accountB, 'Alpha note', NB_B1);

    const res = await get(env, '/api/account/pickables?q=alpha', tokenB);
    const body = (await res.json()) as PickablesResponse;
    expect(body.notebooks.map((n) => n.name)).toEqual(['Work-B']); // only B's notebook
    expect(body.notes.map((n) => n.id)).toEqual([NOTE_B1]); // only B's note
  });

  it('an AGENT token (no share scope) is refused — 403', async () => {
    // Mint a read-only agent token, then try to enumerate pickables with it.
    const mintRes = await app.request(
      '/api/agent-tokens',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({ password: 'picker-password' }),
      },
      env,
    );
    const { token: agentToken } = (await mintRes.json()) as { token: string };
    const res = await get(env, '/api/account/pickables', agentToken);
    expect(res.status).toBe(403);
  });
});
