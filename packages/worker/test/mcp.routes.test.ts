/**
 * Route + protocol + security tests for the read-only MCP server (llm-mcp-integration.md §6):
 * POST /api/mcp, JSON-RPC 2.0 over a stateless Streamable-HTTP POST. The bar mirrors the agent-token
 * surface — this is externally reachable, so the tests pin the security contract, not just the happy path:
 *   - protocol: initialize (version negotiation + serverInfo + capabilities + instructions), tools/list,
 *     ping, notifications/initialized ack;
 *   - auth: missing / garbage / revoked bearer → HTTP 401 (the whole endpoint is bearer-gated);
 *   - tools: a read-only agent token can search_notes + get_note + list_notebooks (the only tools — no writes);
 *   - 🚨 BOLA: account B's agent token cannot get_note account A's note (inherited account isolation → not found).
 *
 * Self-contained harness: better-sqlite3 → D1 shim + the real Hono app + the shared signupToken helper.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { signupToken } from './helpers/passwordToken.js';
import { createAuthStore } from '../src/db/authStore.js';
import { d1Adapter } from '../src/db/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql', '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql', '0013_agent-token-label.sql',
  '0014_grant-family-link.sql',
  '0015_audit-log.sql',
  '0016_usage-counter.sql',
  '0017_oauth-provider.sql', '0018_fts5-note-search.sql', '0019_note-routing-guide.sql',
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

const AUD = 'deltos.mcp.routes';
const makeEnv = (raw: Database.Database): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, AUTH_PEPPER: 'mcp-routes-pepper' } as unknown as Env);

interface JsonRpcResult { jsonrpc: string; id: unknown; result?: any; error?: { code: number; message: string } }

/** POST one JSON-RPC payload, optionally bearing a token. */
const rpc = (env: Env, payload: unknown, token?: string) =>
  app.request('/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  }, env);

/** Mint a read-only agent token for the owner holding `ownerToken`. */
async function mintAgentToken(env: Env, ownerToken: string, ownerPassword: string): Promise<{ token: string; grantId: string }> {
  const res = await app.request('/api/agent-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ label: 'test-mcp', password: ownerPassword }), // H1 step-up: mint requires re-auth
  }, env);
  return (await res.json()) as { token: string; grantId: string };
}

/** Create a note via the real REST route (owner-authed) and return its id. */
async function createNote(env: Env, ownerToken: string, title: string): Promise<string> {
  const id = randomUUID();
  const res = await app.request('/api/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ id, notebookId: null, title, properties: {}, body: [] }),
  }, env);
  if (res.status !== 201) throw new Error(`createNote failed: ${res.status} ${await res.text()}`);
  return id;
}

/** Create a note with BODY paragraph text (to exercise full-text search over the note body). */
async function createNoteWithBody(env: Env, ownerToken: string, title: string, bodyText: string): Promise<string> {
  const id = randomUUID();
  const body = [{ id: randomUUID(), type: 'paragraph', content: { segments: [{ text: bodyText }] } }];
  const res = await app.request('/api/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ id, notebookId: null, title, properties: {}, body }),
  }, env);
  if (res.status !== 201) throw new Error(`createNoteWithBody failed: ${res.status} ${await res.text()}`);
  return id;
}

describe('MCP server — protocol / auth / tools (POST /api/mcp)', () => {
  let env: Env;
  let raw: Database.Database;
  let ownerA: string;
  let accountA: string;
  let agentA: string;

  beforeEach(async () => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    ({ token: ownerA, accountId: accountA } = await signupToken(env, 'mcp-owner', 'mcp-owner-password'));
    ({ token: agentA } = await mintAgentToken(env, ownerA, 'mcp-owner-password'));
  });

  // --- protocol ---------------------------------------------------------------------------------

  it('initialize negotiates the protocol version + returns serverInfo, tools capability, and instructions', async () => {
    const res = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, agentA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.error).toBeUndefined();
    expect(body.result.protocolVersion).toBe('2025-06-18'); // echoes a supported request
    expect(body.result.serverInfo.name).toBe('deltos');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.instructions).toMatch(/read-only/i);
  });

  it('initialize falls back to the latest version for an unknown requested version', async () => {
    const res = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, agentA);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.result.protocolVersion).toBe('2025-06-18');
  });

  it('tools/list advertises exactly the three READ-ONLY tools (no write tools)', async () => {
    const res = await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, agentA);
    const body = (await res.json()) as JsonRpcResult;
    const names = (body.result.tools as Array<{ name: string; inputSchema: unknown }>).map((t) => t.name).sort();
    expect(names).toEqual(['get_note', 'list_notebooks', 'search_notes']);
    for (const t of body.result.tools) expect(t.inputSchema).toBeDefined();
  });

  it('ping returns an empty result', async () => {
    const res = await rpc(env, { jsonrpc: '2.0', id: 9, method: 'ping' }, agentA);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.result).toEqual({});
  });

  it('notifications/initialized is acked with 202 and no body', async () => {
    const res = await rpc(env, { jsonrpc: '2.0', method: 'notifications/initialized' }, agentA);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('GET /api/mcp is 405 (no server→client stream in the stateless v1)', async () => {
    const res = await app.request('/api/mcp', { headers: { Authorization: `Bearer ${agentA}` } }, env);
    expect(res.status).toBe(405);
  });

  it('an unknown method is method-not-found (-32601)', async () => {
    const res = await rpc(env, { jsonrpc: '2.0', id: 5, method: 'does/not/exist' }, agentA);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.error?.code).toBe(-32601);
  });

  // --- auth (the whole endpoint is bearer-gated) ------------------------------------------------

  it('a request with NO bearer is rejected 401', async () => {
    const res = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.error?.code).toBe(-32001);
  });

  it('an unrecognized/garbage bearer is rejected 401', async () => {
    const res = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'dltos_agent_garbage');
    expect(res.status).toBe(401);
  });

  it('a REVOKED agent token is rejected 401', async () => {
    const { token, grantId } = await mintAgentToken(env, ownerA, 'mcp-owner-password');
    // sanity: works before revoke
    expect((await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, token)).status).toBe(200);
    // revoke via the owner route
    await app.request(`/api/agent-tokens/${grantId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ownerA}` } }, env);
    const res = await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, token);
    expect(res.status).toBe(401);
  });

  // --- tools/call (read-only happy path) --------------------------------------------------------

  it('a read-only agent token can search_notes, get_note, and list_notebooks', async () => {
    const noteId = await createNote(env, ownerA, 'Groceries shopping list');
    // seed a notebook directly (notebooks are otherwise only created via the sync push path)
    const nbId = randomUUID();
    raw.prepare(
      `INSERT INTO notebooks (id, accountId, name, defaultCollectionView, version, createdAt, updatedAt, syncSeq)
       VALUES (?, ?, ?, 'list', 1, ?, ?, 1)`,
    ).run(nbId, accountA, 'Errands', new Date().toISOString(), new Date().toISOString());

    // search_notes
    const s = (await (await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'Groceries' } } }, agentA)).json()) as JsonRpcResult;
    expect(s.result.isError).toBeUndefined();
    expect(s.result.structuredContent.results.map((r: { id: string }) => r.id)).toContain(noteId);

    // get_note
    const g = (await (await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_note', arguments: { id: noteId } } }, agentA)).json()) as JsonRpcResult;
    expect(g.result.isError).toBeUndefined();
    expect(g.result.structuredContent.title).toBe('Groceries shopping list');

    // list_notebooks
    const l = (await (await rpc(env, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_notebooks', arguments: {} } }, agentA)).json()) as JsonRpcResult;
    expect(l.result.structuredContent.notebooks.map((n: { id: string }) => n.id)).toContain(nbId);
  });

  it('get_note for an unknown id returns a tool error (not found)', async () => {
    const res = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_note', arguments: { id: randomUUID() } } }, agentA);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not found/i);
  });

  it('an unknown tool name is invalid-params (-32602)', async () => {
    const res = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } }, agentA);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.error?.code).toBe(-32602);
  });

  it('invalid tool arguments are rejected at the boundary (-32602)', async () => {
    const res = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_note', arguments: { id: 'not-a-uuid' } } }, agentA);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.error?.code).toBe(-32602);
  });

  // --- 🚨 BOLA: account isolation is inherited through the existing chokepoint ------------------

  it('🚨 BOLA: account B\'s agent token cannot get_note account A\'s note (not found, no leak)', async () => {
    const aNoteId = await createNote(env, ownerA, 'A private secret note');
    const { token: ownerB } = await signupToken(env, 'mcp-attacker', 'mcp-attacker-password');
    const { token: agentB } = await mintAgentToken(env, ownerB, 'mcp-attacker-password');

    const res = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_note', arguments: { id: aNoteId } } }, agentB);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.result.isError).toBe(true); // not found — indistinguishable from a missing id
    expect(JSON.stringify(body.result)).not.toContain('A private secret note'); // no content leak
  });

  // --- FTS: full-text search over BODY (migration 0018) ------------------------------------------

  it('search_notes finds a note by BODY text, not just title', async () => {
    const noteId = await createNoteWithBody(env, ownerA, 'Meeting', 'discuss the quarterly budget spreadsheet');
    const s = (await (await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'spreadsheet' } } }, agentA)).json()) as JsonRpcResult;
    expect(s.result.isError).toBeUndefined();
    expect(s.result.structuredContent.results.map((r: { id: string }) => r.id)).toContain(noteId);
  });

  it('🚨 BOLA: search_notes never returns another account\'s note by body text', async () => {
    await createNoteWithBody(env, ownerA, 'A note', 'the codeword is xylophone');
    const { token: ownerB } = await signupToken(env, 'mcp-search-attacker', 'mcp-search-attacker-pw');
    const { token: agentB } = await mintAgentToken(env, ownerB, 'mcp-search-attacker-pw');
    const s = (await (await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'xylophone' } } }, agentB)).json()) as JsonRpcResult;
    expect(s.result.structuredContent.results).toHaveLength(0);
    expect(JSON.stringify(s.result)).not.toContain('xylophone'); // no leak of A's content
  });

  // --- C RATE-LIMIT (ROAD-0005 P0): per-token request ceiling -----------------------------------

  it('RATE-LIMIT: a token over its per-token request ceiling is 429 (JSON-RPC rate_limited)', async () => {
    const { token: agentTok, grantId } = await mintAgentToken(env, ownerA, 'mcp-owner-password');
    // Seed the per-token fixed window AT the limit (window-end in the future) so the next request trips it.
    const store = createAuthStore(d1Adapter(env.DB));
    await store.recordThrottleFailure(`mcp:${grantId}`, 600, Date.now() + 60_000, new Date().toISOString());

    const res = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, agentTok);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32029); // RPC.RATE_LIMITED
  });

  it('RATE-LIMIT also meters NOTIFICATIONS — no unmetered 202 work path', async () => {
    const { token: agentTok, grantId } = await mintAgentToken(env, ownerA, 'mcp-owner-password');
    const store = createAuthStore(d1Adapter(env.DB));
    await store.recordThrottleFailure(`mcp:${grantId}`, 600, Date.now() + 60_000, new Date().toISOString());
    // A notification (no id) is now gated by the window too — it must NOT slip through as a 202.
    const res = await rpc(env, { jsonrpc: '2.0', method: 'notifications/initialized' }, agentTok);
    expect(res.status).toBe(429);
  });

  // --- D DAILY QUOTA (ROAD-0005 P4, Tier-2): per-ACCOUNT denial-of-wallet ceiling ----------------

  it('DAILY QUOTA: an account over its daily MCP ceiling is 429 (JSON-RPC rate_limited) across all its tokens', async () => {
    const today = new Date().toISOString().slice(0, 10);
    // Pre-seed the per-ACCOUNT mcp counter AT the cap (50000/day, DAILY_QUOTA.mcp). The cap is keyed on the
    // OWNING account (principal.id = accountA), so any of the account's tokens is over budget.
    raw.prepare(
      `INSERT INTO usageCounter (accountId, metric, dayBucket, count, updatedAt) VALUES (?, 'mcp', ?, 50000, ?)`,
    ).run(accountA, today, new Date().toISOString());

    const res = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_notebooks', arguments: {} } }, agentA);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32029); // RPC.RATE_LIMITED
  });

  it('DAILY QUOTA: a call under the daily ceiling succeeds and increments the per-account mcp counter', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, agentA);
    expect(res.status).toBe(200);
    const row = raw
      .prepare('SELECT count FROM usageCounter WHERE accountId=? AND metric=? AND dayBucket=?')
      .get(accountA, 'mcp', today) as { count: number } | undefined;
    expect(row?.count).toBe(1);
  });
});
