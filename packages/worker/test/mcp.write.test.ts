/**
 * Route + security tests for the MCP WRITE tools (write-tools.md): POST /api/mcp, JSON-RPC tools/call for
 * create_note / update_note / append_block / set_property / trash_note. These apply LIVE (no proposal
 * queue), so the bar is the security contract, not just the happy path:
 *   - a WRITE-scoped agent token can create/update/append/set-property/trash — changes take effect immediately;
 *   - trash is SOFT + recoverable (sys:trashedAt), NEVER the hard deletedAt tombstone (no path to it);
 *   - a READ-ONLY token is DENIED every write tool at the can() chokepoint, and never SEES them in tools/list;
 *   - set_property rejects the reserved sys: namespace at the argument boundary (no out-of-band trash/restore);
 *   - 🚨 BOLA: account B's write token cannot mutate account A's note (inherited account isolation → not found);
 *   - the low daily WRITE cap trips fail-closed;
 *   - initialize instructions + tools/list are SCOPE-AWARE (read-only vs write).
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
import { allMigrations } from './helpers/migrations.js';
import type { AgentWriteOpt } from '@deltos/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = allMigrations();

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

const AUD = 'deltos.mcp.write';
const makeEnv = (raw: Database.Database): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, AUTH_PEPPER: 'mcp-write-pepper' } as unknown as Env);

interface JsonRpcResult { jsonrpc: string; id: unknown; result?: any; error?: { code: number; message: string } }

const rpc = (env: Env, payload: unknown, token?: string) =>
  app.request('/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  }, env);

/** tools/call → the parsed JSON-RPC result (result.result for the McpToolResult). */
async function call(env: Env, token: string, name: string, args: unknown): Promise<JsonRpcResult['result']> {
  const res = await rpc(env, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, token);
  return ((await res.json()) as JsonRpcResult).result;
}

/** get_note via the MCP read tool → the note payload (or the isError result). */
async function getNote(env: Env, token: string, id: string): Promise<any> {
  const r = await call(env, token, 'get_note', { id });
  return r?.structuredContent ?? r;
}

/** Mint an agent token, optionally with a per-scope WRITE opt-in. */
async function mintAgentToken(
  env: Env, ownerToken: string, ownerPassword: string, write?: AgentWriteOpt,
): Promise<{ token: string; grantId: string; scope: string[] }> {
  const res = await app.request('/api/agent-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ label: 'test-write', password: ownerPassword, ...(write ? { write } : {}) }),
  }, env);
  if (res.status !== 201) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  // Grant sets: a default (workspace) token is one row; its resources[0].grantId is the per-resource grantId.
  const body = (await res.json()) as { token: string; scope: string[]; resources: Array<{ grantId: string }> };
  return { token: body.token, grantId: body.resources[0].grantId, scope: body.scope };
}

const WRITE_ALL: AgentWriteOpt = { create: true, update: true, trash: true };

describe('MCP write tools (POST /api/mcp tools/call)', () => {
  let env: Env;
  let raw: Database.Database;
  let ownerA: string;
  let passA: string;

  beforeEach(async () => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    passA = 'write-owner-password';
    ({ token: ownerA } = await signupToken(env, 'write-owner', passA));
  });

  // --- scope opt-in + least-privilege surface -------------------------------------------------------

  it('mint with write opt-in yields a grant scoped read+search+create+write+delete', async () => {
    const { scope } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    expect(new Set(scope)).toEqual(new Set(['read', 'search', 'create', 'write', 'delete']));
    expect(scope).not.toContain('share'); // token management is owner-only; never on an agent grant
  });

  it('a create-only opt-in grants create but NOT write/delete', async () => {
    const { scope } = await mintAgentToken(env, ownerA, passA, { create: true });
    expect(new Set(scope)).toEqual(new Set(['read', 'search', 'create']));
  });

  it('tools/list is scope-filtered: read-only sees the read + import-discovery tools, a write token sees all', async () => {
    const { token: ro } = await mintAgentToken(env, ownerA, passA); // no write opt-in
    const { token: rw } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const roList = await (await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, ro)).json() as JsonRpcResult;
    const rwList = await (await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, rw)).json() as JsonRpcResult;
    // Read-only = the note/notebook readers PLUS the read-scoped import-map discovery tools (writing still gated).
    expect(roList.result.tools.map((t: any) => t.name).sort())
      .toEqual(['check_write_approval', 'get_import_guide', 'get_note', 'list_import_sources', 'list_notebooks', 'request_write_approval', 'search_notes']);
    // A write token sees everything the read token sees PLUS every write tool (incl. the two plugin-declared file
    // tools create_file_note/embed_file via the seam). The two write-approval tools are READ-scope, so they show
    // on BOTH lists.
    expect(rwList.result.tools.map((t: any) => t.name).sort())
      .toEqual(['append_block', 'check_write_approval', 'create_file_note', 'create_note', 'create_notebook', 'embed_file', 'get_import_guide', 'get_note', 'list_import_sources', 'list_notebooks', 'request_write_approval', 'search_notes', 'set_property', 'trash_note', 'update_note']);
  });

  it('initialize instructions are scope-aware (read-only vs write)', async () => {
    const { token: ro } = await mintAgentToken(env, ownerA, passA);
    const { token: rw } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const init = (t: string) => rpc(env, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, t)
      .then((r) => r.json()).then((b: any) => b.result.instructions as string);
    expect(await init(ro)).toMatch(/READ-ONLY/);
    const rwInstr = await init(rw);
    expect(rwInstr).toMatch(/authorized to change notes/i);
    expect(rwInstr).toMatch(/UNTRUSTED DATA/); // the prompt-injection guardrail is taught to write tokens
    expect(rwInstr).toMatch(/MARKDOWN/); // bodies accept markdown → native blocks
    expect(rwInstr).toMatch(/TITLES are PLAIN TEXT/); // titles must not carry markdown
  });

  // --- happy path (live-apply) ----------------------------------------------------------------------

  it('create_note applies live — the note exists with the authored title + body text', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const r = await call(env, token, 'create_note', { title: 'From Claude', text: 'line one\nline two' });
    expect(r.structuredContent.status).toBe('applied');
    const id = r.structuredContent.note.id;
    const note = await getNote(env, token, id);
    expect(note.title).toBe('From Claude');
    // text → paragraph blocks with the canonical { segments:[{text}] } shape (renders + is FTS-indexable).
    expect(note.body.map((b: any) => b.content.segments[0]?.text ?? '')).toEqual(['line one', 'line two']);
  });

  it('create_note is findable by body text via search_notes (FTS indexed on write)', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    await call(env, token, 'create_note', { title: 'Recipe', text: 'roast the aubergine slowly' });
    const r = await call(env, token, 'search_notes', { query: 'aubergine' });
    expect(r.structuredContent.results.some((n: any) => n.title === 'Recipe')).toBe(true);
  });

  it('update_note replaces the title + body live', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const created = await call(env, token, 'create_note', { title: 'Old', text: 'old body' });
    const id = created.structuredContent.note.id;
    await call(env, token, 'update_note', { id, title: 'New', text: 'new body' });
    const note = await getNote(env, token, id);
    expect(note.title).toBe('New');
    expect(note.body[0].content.segments[0].text).toBe('new body');
  });

  it('append_block adds to the END without touching existing content', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const created = await call(env, token, 'create_note', { text: 'first' });
    const id = created.structuredContent.note.id;
    await call(env, token, 'append_block', { id, text: 'second' });
    const note = await getNote(env, token, id);
    expect(note.body.map((b: any) => b.content.segments[0]?.text)).toEqual(['first', 'second']);
  });

  // --- create_notebook (workspace-scoped create) ----------------------------------------------------

  it('create_notebook applies live — the notebook appears in list_notebooks with a server-minted id', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const r = await call(env, token, 'create_notebook', { name: 'Recipes' });
    expect(r.structuredContent.status).toBe('applied');
    expect(r.structuredContent.notebook.name).toBe('Recipes');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(r.structuredContent.notebook.id).toMatch(uuid); // server-minted, not client-chosen
    // It shows up in the account's notebook list, and a note can be filed into it.
    const list = await call(env, token, 'list_notebooks', {});
    const nb = list.structuredContent.notebooks.find((n: any) => n.id === r.structuredContent.notebook.id);
    expect(nb?.name).toBe('Recipes');
    const note = await call(env, token, 'create_note', { title: 'Ragu', notebookId: nb.id });
    const got = await getNote(env, token, note.structuredContent.note.id);
    expect(got.notebookId).toBe(nb.id);
  });

  it('create_notebook rejects an empty name and an over-200-char name at the boundary', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const empty = await rpc(env, {
      jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'create_notebook', arguments: { name: '' } },
    }, token).then((r) => r.json()) as JsonRpcResult;
    expect(empty.error?.code).toBe(-32602);
    const tooLong = await rpc(env, {
      jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'create_notebook', arguments: { name: 'x'.repeat(201) } },
    }, token).then((r) => r.json()) as JsonRpcResult;
    expect(tooLong.error?.code).toBe(-32602);
  });

  it('a READ-ONLY token is denied create_notebook at the chokepoint', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA); // no write opt-in
    const r = await call(env, token, 'create_notebook', { name: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/forbidden/i);
  });

  // --- markdown bodies render as native blocks; titles are plain text -------------------------------

  it('create_note parses a markdown body into native blocks (heading + checklist todos)', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const md = '## Phase 1\n- [ ] change oil\n- [x] top up coolant';
    const r = await call(env, token, 'create_note', { title: 'Jetta service', text: md });
    const note = await getNote(env, token, r.structuredContent.note.id);
    expect(note.body[0].type).toBe('heading');
    expect(note.body[0].content.level).toBe(2);
    const list = note.body[1];
    expect(list.type).toBe('list');
    expect(list.children.map((c: any) => c.type)).toEqual(['todo', 'todo']);
    expect(list.children.map((c: any) => c.content.checked)).toEqual([false, true]);
    // Every block id — including nested item ids — is a valid UUID (a non-UUID id 400s the sync push).
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const b of note.body) {
      expect(b.id).toMatch(uuid);
      for (const c of b.children ?? []) expect(c.id).toMatch(uuid);
    }
  });

  it('create_note parses inline marks (bold) in the body', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const r = await call(env, token, 'create_note', { text: 'this is **important** stuff' });
    const note = await getNote(env, token, r.structuredContent.note.id);
    expect(note.body[0].content.segments).toEqual([
      { text: 'this is ' },
      { text: 'important', bold: true },
      { text: ' stuff' },
    ]);
  });

  it('create_note strips a leading markdown heading marker from the TITLE (plain text)', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const r = await call(env, token, 'create_note', { title: '# 2005 Jetta maintenance' });
    const note = await getNote(env, token, r.structuredContent.note.id);
    expect(note.title).toBe('2005 Jetta maintenance');
  });

  it('update_note strips a leading heading marker from a new title', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const created = await call(env, token, 'create_note', { title: 'plain', text: 'x' });
    const id = created.structuredContent.note.id;
    await call(env, token, 'update_note', { id, title: '### Big Title' });
    const note = await getNote(env, token, id);
    expect(note.title).toBe('Big Title');
  });

  it('append_block appends parsed markdown blocks (a bullet list) to the end', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const created = await call(env, token, 'create_note', { text: 'intro' });
    const id = created.structuredContent.note.id;
    await call(env, token, 'append_block', { id, text: '- one\n- two' });
    const note = await getNote(env, token, id);
    expect(note.body.map((b: any) => b.type)).toEqual(['paragraph', 'list']);
    expect(note.body[1].children.map((c: any) => c.content.segments[0].text)).toEqual(['one', 'two']);
  });

  it('set_property sets a user metadata key', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const created = await call(env, token, 'create_note', { title: 'tagged' });
    const id = created.structuredContent.note.id;
    await call(env, token, 'set_property', { id, key: 'status', value: { type: 'text', value: 'done' } });
    const note = await getNote(env, token, id);
    expect(note.properties.status).toEqual({ type: 'text', value: 'done' });
  });

  // --- delete = soft trash, never a hard tombstone --------------------------------------------------

  it('trash_note sets the recoverable sys:trashedAt flag and NEVER the hard deletedAt tombstone', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const created = await call(env, token, 'create_note', { title: 'to trash', text: 'bye' });
    const id = created.structuredContent.note.id;
    await call(env, token, 'trash_note', { id });
    const note = await getNote(env, token, id);
    expect(note.properties['sys:trashedAt']).toBeDefined();
    expect(note.properties['sys:trashedAt'].type).toBe('date');
    // The hard tombstone column is untouched — the note is recoverable, not destroyed.
    const row = raw.prepare('SELECT deletedAt FROM notes WHERE id = ?').get(id) as { deletedAt: string | null };
    expect(row.deletedAt).toBeNull();
    // A trashed note drops out of search (TRASH_LIVE_CLAUSE) but is still directly readable for restore.
    const s = await call(env, token, 'search_notes', { query: 'bye' });
    expect(s.structuredContent.results.some((n: any) => n.id === id)).toBe(false);
  });

  it('trash_note is idempotent on an already-trashed note', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const created = await call(env, token, 'create_note', { title: 'x' });
    const id = created.structuredContent.note.id;
    await call(env, token, 'trash_note', { id });
    const again = await call(env, token, 'trash_note', { id });
    expect(again.structuredContent.status).toBe('applied');
  });

  // --- authorization / injection guardrails ---------------------------------------------------------

  it('a READ-ONLY token is DENIED every write tool at the chokepoint', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA); // no write opt-in
    for (const [name, args] of [
      ['create_note', { title: 't' }],
      ['update_note', { id: '00000000-0000-4000-8000-000000000001', title: 't' }],
      ['append_block', { id: '00000000-0000-4000-8000-000000000001', text: 't' }],
      ['set_property', { id: '00000000-0000-4000-8000-000000000001', key: 'k', value: { type: 'text', value: 'v' } }],
      ['trash_note', { id: '00000000-0000-4000-8000-000000000001' }],
    ] as const) {
      const r = await call(env, token, name, args);
      expect(r.isError, `${name} should be forbidden`).toBe(true);
      expect(r.content[0].text).toMatch(/forbidden/i);
    }
  });

  it('set_property REJECTS the reserved sys: namespace at the argument boundary', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const created = await call(env, token, 'create_note', { title: 'x' });
    const id = created.structuredContent.note.id;
    const res = await rpc(env, {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'set_property', arguments: { id, key: 'sys:trashedAt', value: { type: 'date', value: new Date(0).toISOString() } } },
    }, token);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.error?.code).toBe(-32602); // invalid params — no out-of-band trash via a raw property write
  });

  it('🚨 BOLA: account B\'s write token cannot mutate account A\'s note (not found, no clobber)', async () => {
    const { token: aWrite } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const created = await call(env, aWrite, 'create_note', { title: 'A private', text: 'secret' });
    const id = created.structuredContent.note.id;

    const { token: ownerB } = await signupToken(env, 'owner-b', 'owner-b-password');
    const { token: bWrite } = await mintAgentToken(env, ownerB, 'owner-b-password', WRITE_ALL);
    const r = await call(env, bWrite, 'update_note', { id, title: 'HACKED' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not found/i);
    // A's note is untouched.
    const note = await getNote(env, aWrite, id);
    expect(note.title).toBe('A private');
  });

  // --- write cap (denial-of-wallet / injection blast-radius) ----------------------------------------

  it('the daily WRITE cap trips fail-closed (read tools remain unaffected)', async () => {
    const { token, grantId } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    // Resolve the acting account, then seed the mcpWrite counter to the cap for today.
    const acct = raw.prepare('SELECT principalId FROM grants WHERE grantId = ?').get(grantId) as { principalId: string };
    const today = new Date().toISOString().slice(0, 10);
    raw.prepare('INSERT INTO usageCounter (accountId, metric, dayBucket, count, updatedAt) VALUES (?,?,?,?,?)')
      .run(acct.principalId, 'mcpWrite', today, 100, new Date().toISOString());

    const w = await call(env, token, 'create_note', { title: 'over cap' });
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toMatch(/daily write limit/i);
    // Reads still work — the cap is write-only.
    const s = await call(env, token, 'search_notes', { query: 'anything' });
    expect(s.isError).toBeUndefined();
  });
});
