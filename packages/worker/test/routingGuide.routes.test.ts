/**
 * Route + contract tests for the Note routing guide (account setting → MCP). Owner-authed GET/PUT on
 * `/api/account/routing-guide`, surfaced to the agent via `list_notebooks.routingGuide`:
 *   - owner round-trips the guide (GET null → PUT → GET the value); empty/whitespace clears to null;
 *   - a >8KB body is rejected at the schema boundary;
 *   - an AGENT token is 403 on GET and PUT (owner-only op:'share') — it can only READ via list_notebooks;
 *   - 🚨 BOLA: account B's guide is independent of A's;
 *   - list_notebooks carries the set routingGuide;
 *   - mcpInstructions(write) teaches the agent to read the guide before filing.
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
import { mcpInstructions } from '../src/mcp/tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql', '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql', '0013_agent-token-label.sql', '0014_grant-family-link.sql',
  '0015_audit-log.sql', '0016_usage-counter.sql', '0017_oauth-provider.sql', '0018_fts5-note-search.sql', '0019_note-routing-guide.sql', '0020_grant-sets.sql',
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

const AUD = 'deltos.routing.guide';
const makeEnv = (raw: Database.Database): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, AUTH_PEPPER: 'routing-guide-pepper' } as unknown as Env);

const authed = (token: string) => ({ 'content-type': 'application/json', Authorization: `Bearer ${token}` });

const getGuide = (env: Env, token: string) =>
  app.request('/api/account/routing-guide', { method: 'GET', headers: authed(token) }, env);
const putGuide = (env: Env, token: string, routingGuide: string | null) =>
  app.request('/api/account/routing-guide', { method: 'PUT', headers: authed(token), body: JSON.stringify({ routingGuide }) }, env);

/** Mint an agent token (read-only by default; workspace-scoped). */
async function mintAgentToken(env: Env, ownerToken: string, ownerPassword: string): Promise<string> {
  const res = await app.request('/api/agent-tokens', {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ label: 'rg', password: ownerPassword }),
  }, env);
  if (res.status !== 201) throw new Error(`mint failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

describe('Note routing guide (GET/PUT /api/account/routing-guide + MCP)', () => {
  let env: Env;
  let raw: Database.Database;
  let ownerA: string;
  const passA = 'routing-owner-password';

  beforeEach(async () => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    ({ token: ownerA } = await signupToken(env, 'routing-owner', passA));
  });

  it('starts null, round-trips a set value', async () => {
    expect(await (await getGuide(env, ownerA)).json()).toEqual({ routingGuide: null });
    const guide = 'Dev: software, homelab.\nLife: personal + property.\nDefault: ask; else All Notes.';
    const put = await putGuide(env, ownerA, guide);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ routingGuide: guide });
    expect(await (await getGuide(env, ownerA)).json()).toEqual({ routingGuide: guide });
  });

  it('empty / whitespace-only normalizes to null (clears the guide)', async () => {
    await putGuide(env, ownerA, 'something');
    const cleared = await putGuide(env, ownerA, '   \n  ');
    expect(await cleared.json()).toEqual({ routingGuide: null });
    expect(await (await getGuide(env, ownerA)).json()).toEqual({ routingGuide: null });
  });

  it('an explicit null clears the guide', async () => {
    await putGuide(env, ownerA, 'x');
    const cleared = await putGuide(env, ownerA, null);
    expect(await cleared.json()).toEqual({ routingGuide: null });
  });

  it('rejects a body over the ~8KB cap at the schema boundary (400)', async () => {
    const tooBig = 'a'.repeat(8193);
    const res = await putGuide(env, ownerA, tooBig);
    expect(res.status).toBe(400);
    expect(await (await getGuide(env, ownerA)).json()).toEqual({ routingGuide: null }); // unchanged
  });

  it('an AGENT token is 403 on GET and PUT (owner-only op:share)', async () => {
    await putGuide(env, ownerA, 'owner-set');
    const agent = await mintAgentToken(env, ownerA, passA);
    expect((await getGuide(env, agent)).status).toBe(403);
    expect((await putGuide(env, agent, 'HACKED')).status).toBe(403);
    // The guide is untouched by the rejected agent write.
    expect(await (await getGuide(env, ownerA)).json()).toEqual({ routingGuide: 'owner-set' });
  });

  it('🚨 BOLA: account B\'s guide is independent of account A\'s', async () => {
    await putGuide(env, ownerA, 'A-guide');
    const { token: ownerB } = await signupToken(env, 'routing-owner-b', 'owner-b-password');
    expect(await (await getGuide(env, ownerB)).json()).toEqual({ routingGuide: null });
    await putGuide(env, ownerB, 'B-guide');
    expect(await (await getGuide(env, ownerA)).json()).toEqual({ routingGuide: 'A-guide' });
    expect(await (await getGuide(env, ownerB)).json()).toEqual({ routingGuide: 'B-guide' });
  });

  it('MCP list_notebooks carries the routingGuide (read token, one round trip)', async () => {
    await putGuide(env, ownerA, 'file dev stuff in Dev');
    const agent = await mintAgentToken(env, ownerA, passA);
    const res = await app.request('/api/mcp', {
      method: 'POST', headers: authed(agent),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_notebooks', arguments: {} } }),
    }, env);
    const body = (await res.json()) as { result: { structuredContent: { notebooks: unknown[]; routingGuide: string | null } } };
    expect(body.result.structuredContent.routingGuide).toBe('file dev stuff in Dev');
    expect(Array.isArray(body.result.structuredContent.notebooks)).toBe(true);
  });

  it('list_notebooks routingGuide is null when unset', async () => {
    const agent = await mintAgentToken(env, ownerA, passA);
    const res = await app.request('/api/mcp', {
      method: 'POST', headers: authed(agent),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_notebooks', arguments: {} } }),
    }, env);
    const body = (await res.json()) as { result: { structuredContent: { routingGuide: string | null } } };
    expect(body.result.structuredContent.routingGuide).toBeNull();
  });

  it('mcpInstructions(write) teaches the agent to read the routing guide before filing', () => {
    const instr = mcpInstructions(true);
    expect(instr).toMatch(/routingGuide/);
    expect(instr).toMatch(/list_notebooks/);
    expect(instr).toMatch(/All Notes/);
    // read-only instructions do not describe filing (no write tools)
    expect(mcpInstructions(false)).not.toMatch(/routingGuide/);
  });
});
