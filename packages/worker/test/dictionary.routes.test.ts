/**
 * Route-level integration tests for the custom-dictionary synced entity (§5.2) over POST /api/sync/push +
 * GET /api/sync/pull. Guards the set-semantics conflict-free contract (add upserts + un-tombstones, remove
 * tombstones, idempotent), the unified-cursor ride (dict pulls alongside notes/notebooks on one syncSeq),
 * and — the HARD requirement — ACCOUNT ISOLATION at the real HTTP boundary (account B never sees A's words).
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql',
  '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql',
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

const AUD = 'deltos.dictionary.routes';
const makeEnv = (raw: Database.Database): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, AUTH_PEPPER: 'dictionary-routes-pepper' } as unknown as Env);

const post = (env: Env, path: string, body: unknown, token: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }, env);

interface DictWord { word: string; deletedAt: string | null; syncSeq: number }
interface PullShape {
  notes: Array<{ id: string }>;
  dictionaryWords: DictWord[];
  nextCursor: number;
  hasMore: boolean;
}
const pull = async (env: Env, token: string, cursor = 0): Promise<PullShape> => {
  const res = await app.request(`/api/sync/pull?cursor=${cursor}`, { headers: { Authorization: `Bearer ${token}` } }, env);
  return res.json() as Promise<PullShape>;
};

const NOTE = '00000000-0000-4000-e000-000000000001';

describe('custom dictionary — synced entity (§5.2, route-level)', () => {
  let env: Env;
  let token: string;

  beforeEach(async () => {
    const raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    ({ token } = await signupToken(env, 'dict-user', 'dict-routes-password'));
  });

  it('add words → pull returns them live; result is always accepted with a syncSeq', async () => {
    const res = await post(env, '/api/sync/push', {
      dictionaryEntries: [{ word: 'deltos' }, { word: 'blackgate' }],
    }, token);
    expect(res.status).toBe(200);
    const json = await res.json() as { dictionaryResults: Array<{ word: string; outcome: string; syncSeq: number }> };
    expect(json.dictionaryResults).toHaveLength(2);
    expect(json.dictionaryResults.every((r) => r.outcome === 'accepted' && r.syncSeq > 0)).toBe(true);

    const pulled = await pull(env, token);
    const words = pulled.dictionaryWords.filter((w) => w.deletedAt === null).map((w) => w.word).sort();
    expect(words).toEqual(['blackgate', 'deltos']);
  });

  it('remove (delete:true) → pull streams the tombstone (deletedAt set)', async () => {
    await post(env, '/api/sync/push', { dictionaryEntries: [{ word: 'deltos' }] }, token);
    await post(env, '/api/sync/push', { dictionaryEntries: [{ word: 'deltos', delete: true }] }, token);

    const pulled = await pull(env, token);
    const row = pulled.dictionaryWords.find((w) => w.word === 'deltos');
    expect(row).toBeDefined();
    expect(row!.deletedAt).not.toBeNull(); // tombstone streamed so other devices drop it
  });

  it('re-adding a removed word un-tombstones it (idempotent set semantics, conflict-free)', async () => {
    await post(env, '/api/sync/push', { dictionaryEntries: [{ word: 'deltos' }] }, token);
    await post(env, '/api/sync/push', { dictionaryEntries: [{ word: 'deltos', delete: true }] }, token);
    await post(env, '/api/sync/push', { dictionaryEntries: [{ word: 'deltos' }] }, token); // re-add

    const pulled = await pull(env, token);
    const row = pulled.dictionaryWords.find((w) => w.word === 'deltos');
    expect(row!.deletedAt).toBeNull(); // live again — one row, not a duplicate
    expect(pulled.dictionaryWords.filter((w) => w.word === 'deltos')).toHaveLength(1);
  });

  it('rides the unified per-account cursor — a word and a note pull together, cursor advances', async () => {
    await post(env, '/api/sync/push', {
      entries: [{ id: NOTE, baseVersion: 0, draft: { title: 'n', properties: {}, body: [] } }],
      dictionaryEntries: [{ word: 'deltos' }],
    }, token);

    const pulled = await pull(env, token, 0);
    expect(pulled.notes.map((n) => n.id)).toContain(NOTE);
    expect(pulled.dictionaryWords.map((w) => w.word)).toContain('deltos');
    expect(pulled.nextCursor).toBeGreaterThan(0);

    // Incremental pull from the new cursor returns nothing further (no spurious re-stream).
    const after = await pull(env, token, pulled.nextCursor);
    expect(after.dictionaryWords).toHaveLength(0);
    expect(after.notes).toHaveLength(0);
  });

  it('🚨 ACCOUNT ISOLATION: account B never sees account A\'s words (HARD requirement)', async () => {
    const { token: tokenB } = await signupToken(env, 'dict-user-B', 'dict-routes-password-B');

    await post(env, '/api/sync/push', { dictionaryEntries: [{ word: 'asecret' }, { word: 'private' }] }, token); // A
    await post(env, '/api/sync/push', { dictionaryEntries: [{ word: 'bword' }] }, tokenB); // B

    const a = await pull(env, token);
    const b = await pull(env, tokenB);
    expect(a.dictionaryWords.map((w) => w.word).sort()).toEqual(['asecret', 'private']);
    expect(b.dictionaryWords.map((w) => w.word)).toEqual(['bword']); // B sees ONLY its own — no A leakage
  });

  it('the same word added by two accounts stays two independent rows (no cross-account merge)', async () => {
    const { token: tokenB } = await signupToken(env, 'dict-user-B2', 'dict-routes-password-B2');
    await post(env, '/api/sync/push', { dictionaryEntries: [{ word: 'shared' }] }, token);
    await post(env, '/api/sync/push', { dictionaryEntries: [{ word: 'shared' }] }, tokenB);
    // B removing "shared" must NOT affect A's "shared".
    await post(env, '/api/sync/push', { dictionaryEntries: [{ word: 'shared', delete: true }] }, tokenB);

    const a = await pull(env, token);
    expect(a.dictionaryWords.find((w) => w.word === 'shared')!.deletedAt).toBeNull(); // A's row untouched
  });
});
