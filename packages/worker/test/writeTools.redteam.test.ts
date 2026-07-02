/**
 * P5 RED-TEAM — adversarial suite over the MCP write-tools threat model (write-tools.md §8, ROAD-0005).
 *
 * Posture: the adversary is a COMPROMISED / prompt-injected agent holding a write token. Each test drives an
 * ATTACK and asserts the control that defangs it. The audit log is the scoreboard: every write attempt (allow
 * AND deny) must leave a reconstructable row, and no mutation may occur without one.
 *
 * Vectors (each → a named attack below):
 *   1. injection→destruction is RECOVERABLE, never permanent (soft-trash only; no hard-tombstone path);
 *   2. read→write scope escalation DENIED on BOTH auth paths (mint route + OAuth consent), and audited;
 *   3. cross-account BOLA — a write token cannot mutate another account's notes (workspace + notebook scoped);
 *   4. out-of-band sys:-key smuggling BLOCKED at the argument boundary (no tool writes a reserved key);
 *   5. the mcpWrite cap is per-ACCOUNT — a fresh token does not reset it; fail-closed BEFORE the mutation;
 *   6. audit = scoreboard — every write tool call (allow + deny) is projected to auditLog; no act-without-a-trace;
 *   7. unified clamp + step-up integrity — write only via an explicit opt-in through clampAgentScopes; never `share`;
 *   8. misc — trashed notes can't be silently un-trashed by an agent; server-owned ids.
 *
 * Self-contained harness: better-sqlite3 → D1 shim + the real Hono app + the shared signupToken helper.
 * (The AUDIT AE binding is unbound in tests → the append-only firehose no-ops, but the D1 auditLog PROJECTION
 * still writes, so audit rows are assertable. The structural "data layer can't reach AUDIT" invariant is
 * pinned separately by audit.separation.test.ts, which this suite deliberately does not touch.)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { signupToken } from './helpers/passwordToken.js';
import type { AgentWriteOpt } from '@deltos/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql', '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql', '0013_agent-token-label.sql', '0014_grant-family-link.sql',
  '0015_audit-log.sql', '0016_usage-counter.sql', '0017_oauth-provider.sql', '0018_fts5-note-search.sql', '0019_note-routing-guide.sql',
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

const AUD = 'deltos.redteam';
const makeEnv = (raw: Database.Database): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, AUTH_PEPPER: 'redteam-pepper' } as unknown as Env);

interface JsonRpcResult { jsonrpc: string; id: unknown; result?: any; error?: { code: number; message: string } }

const rpc = (env: Env, payload: unknown, token?: string) =>
  app.request('/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  }, env);

/** tools/call → the McpToolResult (result.result). */
async function call(env: Env, token: string, name: string, args: unknown): Promise<any> {
  const res = await rpc(env, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, token);
  return ((await res.json()) as JsonRpcResult).result;
}
/** The raw JSON-RPC envelope (to inspect protocol-level errors). */
async function rawCall(env: Env, token: string, name: string, args: unknown): Promise<JsonRpcResult> {
  const res = await rpc(env, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, token);
  return (await res.json()) as JsonRpcResult;
}
async function getNote(env: Env, token: string, id: string): Promise<any> {
  const r = await call(env, token, 'get_note', { id });
  return r?.structuredContent ?? r;
}

/** Mint an agent token via the manual route, with an optional per-scope write opt-in + notebook scope. */
async function mintAgentToken(
  env: Env, ownerToken: string, ownerPassword: string,
  opts: { write?: AgentWriteOpt; notebookId?: string } = {},
): Promise<{ token: string; grantId: string; scope: string[] }> {
  const res = await app.request('/api/agent-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      label: 'redteam', password: ownerPassword,
      ...(opts.write ? { write: opts.write } : {}),
      ...(opts.notebookId ? { notebookId: opts.notebookId } : {}),
    }),
  }, env);
  if (res.status !== 201) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { token: string; grantId: string; scope: string[] };
}

// --- OAuth full-flow helper (register → consent → token) — to red-team OAuth-minted tokens too ------------
const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/** Run the whole OAuth authorize→token flow and return the issued access token + its granted scope. */
async function oauthToken(
  env: Env, ownerToken: string, ownerPassword: string, write?: AgentWriteOpt,
): Promise<{ token: string; scope: string }> {
  const redirect = 'https://claude.ai/cb';
  const reg = await app.request('/api/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: 'Claude' }),
  }, env);
  const { client_id } = await reg.json();
  const cRes = await app.request('/api/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      client_id, redirect_uri: redirect, code_challenge: PKCE_CHALLENGE, code_challenge_method: 'S256',
      password: ownerPassword, ...(write ? { write } : {}),
    }),
  }, env);
  if (cRes.status !== 200) throw new Error(`consent failed: ${cRes.status} ${await cRes.text()}`);
  const { code } = await cRes.json();
  const tRes = await app.request('/api/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirect, client_id, code_verifier: PKCE_VERIFIER,
    }).toString(),
  }, env);
  const tok = await tRes.json();
  return { token: tok.access_token, scope: tok.scope };
}

/** Every auditLog row for an account (the D1 projection = the readable scoreboard). */
function auditRows(raw: Database.Database, accountId: string): Array<{ surface: string; action: string; result: string; credentialRef: string | null; detail: string | null }> {
  return raw.prepare('SELECT surface, action, result, credentialRef, detail FROM auditLog WHERE accountId = ? ORDER BY id').all(accountId) as any;
}

const WRITE_ALL: AgentWriteOpt = { create: true, update: true, trash: true };
const WRITE_TOOLS = ['create_note', 'update_note', 'append_block', 'set_property', 'trash_note'] as const;
const DUMMY_NOTE = '00000000-0000-4000-8000-0000000000ff';
const argsFor = (name: string): Record<string, unknown> => {
  switch (name) {
    case 'create_note': return { title: 'x' };
    case 'update_note': return { id: DUMMY_NOTE, title: 'x' };
    case 'append_block': return { id: DUMMY_NOTE, text: 'x' };
    case 'set_property': return { id: DUMMY_NOTE, key: 'k', value: { type: 'text', value: 'v' } };
    case 'trash_note': return { id: DUMMY_NOTE };
    default: return {};
  }
};

describe('P5 red-team — MCP write tools threat model', () => {
  let env: Env;
  let raw: Database.Database;
  let ownerA: string;
  let accountA: string;
  let passA: string;

  beforeEach(async () => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    passA = 'redteam-owner-password';
    ({ token: ownerA, accountId: accountA } = await signupToken(env, 'redteam-owner', passA));
  });

  // ── Vector 1 — injection→destruction is RECOVERABLE, never permanent ─────────────────────────────
  it('V1: an injected mass-trash is SOFT + recoverable — never a hard tombstone', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, { write: WRITE_ALL });
    // The agent obeys a prompt-injection ("delete all notes") and trashes everything it created.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await call(env, token, 'create_note', { title: `note ${i}`, text: `body ${i}` });
      ids.push(r.structuredContent.note.id);
    }
    for (const id of ids) await call(env, token, 'trash_note', { id });

    for (const id of ids) {
      // Row still EXISTS with content intact — the hard tombstone column was never touched.
      const row = raw.prepare('SELECT deletedAt, title, body, properties FROM notes WHERE id = ?').get(id) as any;
      expect(row).toBeTruthy();
      expect(row.deletedAt).toBeNull();               // soft-trash ONLY — recoverable
      expect(row.title).toMatch(/^note \d$/);         // content preserved
      expect(JSON.parse(row.properties)['sys:trashedAt']).toBeDefined();
    }
  });

  it('V1: no write tool exposes a hard-delete op — the tool surface can only soft-trash', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, { write: WRITE_ALL });
    const list = await (await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, token)).json() as JsonRpcResult;
    const names: string[] = list.result.tools.map((t: any) => t.name);
    // The only delete-shaped tool is trash_note; there is no destroy/purge/delete tool at all.
    expect(names.filter((n) => /delete|destroy|purge|remove/i.test(n))).toEqual([]);
    expect(names).toContain('trash_note');
  });

  // ── Vector 2 — read→write escalation DENIED on BOTH auth paths, and audited ───────────────────────
  it('V2: a read-only MINT-route token is denied every write tool (+ each denial is audited)', async () => {
    const { token, grantId } = await mintAgentToken(env, ownerA, passA); // no write opt-in
    for (const name of WRITE_TOOLS) {
      const r = await call(env, token, name, argsFor(name));
      expect(r.isError, `${name} must be forbidden`).toBe(true);
      expect(r.content[0].text).toMatch(/forbidden/i);
    }
    // Scoreboard: a deny row per attempt, tagged mcp + the agent grantId (act-without-a-trace impossible).
    const denies = auditRows(raw, accountA).filter((r) => r.surface === 'mcp' && r.result === 'deny');
    expect(denies.length).toBeGreaterThanOrEqual(WRITE_TOOLS.length);
    expect(denies.every((r) => r.credentialRef === grantId)).toBe(true);
  });

  it('V2: a read-only OAUTH-consent token is denied write (same clamp, other surface)', async () => {
    const { token, scope } = await oauthToken(env, ownerA, passA); // consent without write opt-in
    expect(scope).toBe('read search');
    const r = await call(env, token, 'create_note', { title: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/forbidden/i);
  });

  // ── Vector 3 — cross-account BOLA ─────────────────────────────────────────────────────────────────
  it('V3: a workspace write token cannot mutate another account\'s notes (no clobber, no oracle)', async () => {
    const { token: aWrite } = await mintAgentToken(env, ownerA, passA, { write: WRITE_ALL });
    const created = await call(env, aWrite, 'create_note', { title: 'A secret', text: 'A body' });
    const aId = created.structuredContent.note.id;

    const { token: ownerB } = await signupToken(env, 'attacker-b', 'attacker-b-pw');
    const { token: bWrite } = await mintAgentToken(env, ownerB, 'attacker-b-pw', { write: WRITE_ALL });

    for (const [name, args] of [
      ['update_note', { id: aId, title: 'HACKED' }],
      ['append_block', { id: aId, text: 'HACKED' }],
      ['set_property', { id: aId, key: 'pwned', value: { type: 'text', value: 'yes' } }],
      ['trash_note', { id: aId }],
    ] as const) {
      const r = await call(env, bWrite, name, args);
      expect(r.isError, `${name} cross-account must be not-found`).toBe(true);
      expect(r.content[0].text).toMatch(/not found/i); // no cross-account existence oracle
    }
    // A's note is byte-for-byte untouched.
    const note = await getNote(env, aWrite, aId);
    expect(note.title).toBe('A secret');
    expect(note.properties.pwned).toBeUndefined();
    expect(note.properties['sys:trashedAt']).toBeUndefined();
  });

  it('V3: a notebook-scoped write token cannot reach note-level ops (no note→notebook resolver)', async () => {
    const notebookId = '00000000-0000-4000-9000-0000000000a1';
    const { token } = await mintAgentToken(env, ownerA, passA, { write: WRITE_ALL, notebookId });
    // create INTO the scoped notebook is allowed (exact resource match)…
    const ok = await call(env, token, 'create_note', { title: 'in scope', notebookId });
    expect(ok.structuredContent.status).toBe('applied');
    const id = ok.structuredContent.note.id;
    // …but a note(id)-addressed op is DENIED — the grant covers notebook(N), not note(id) under it.
    const denied = await call(env, token, 'update_note', { id, title: 'x' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/forbidden/i);
    // …and creating into a DIFFERENT notebook is denied (no coverage).
    const other = await call(env, token, 'create_note', { title: 'y', notebookId: '00000000-0000-4000-9000-0000000000b2' });
    expect(other.isError).toBe(true);
  });

  // ── Vector 4 — out-of-band sys:-key smuggling BLOCKED ─────────────────────────────────────────────
  it('V4: set_property cannot write ANY reserved sys: key (out-of-band trash/restore blocked)', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, { write: WRITE_ALL });
    const id = (await call(env, token, 'create_note', { title: 'x' })).structuredContent.note.id;
    for (const key of ['sys:trashedAt', 'sys:pinned', 'sys:anything']) {
      const env7 = await rawCall(env, token, 'set_property', { id, key, value: { type: 'text', value: 'v' } });
      expect(env7.error?.code, `key ${key}`).toBe(-32602); // rejected at the arg boundary
    }
  });

  it('V4: no content tool accepts a raw properties bag (strict schema — can\'t smuggle sys: via create/update)', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, { write: WRITE_ALL });
    const id = (await call(env, token, 'create_note', { title: 'x' })).structuredContent.note.id;
    // create_note / update_note / append_block are .strict() with NO properties field → an injected
    // properties bag carrying a sys: key is rejected as invalid params, never merged.
    const c = await rawCall(env, token, 'create_note', { title: 'x', properties: { 'sys:trashedAt': { type: 'date', value: '2020-01-01T00:00:00.000Z' } } });
    expect(c.error?.code).toBe(-32602);
    const u = await rawCall(env, token, 'update_note', { id, properties: { 'sys:pinned': { type: 'boolean', value: true } } });
    expect(u.error?.code).toBe(-32602);
  });

  // ── Vector 5 — the mcpWrite cap is per-ACCOUNT (a fresh token can't reset it) ─────────────────────
  it('V5: the daily write cap holds ACROSS tokens of the same account (fail-closed, reads unaffected)', async () => {
    // Seed the account's mcpWrite counter to the cap for today.
    const today = new Date().toISOString().slice(0, 10);
    raw.prepare('INSERT INTO usageCounter (accountId, metric, dayBucket, count, updatedAt) VALUES (?,?,?,?,?)')
      .run(accountA, 'mcpWrite', today, 100, new Date().toISOString());
    // A brand-NEW token (different grantId, same account) is still capped — the budget is per-account.
    const { token: fresh } = await mintAgentToken(env, ownerA, passA, { write: WRITE_ALL });
    const w = await call(env, fresh, 'create_note', { title: 'over cap' });
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toMatch(/daily write limit/i);
    // Reads are unaffected by the write cap.
    const s = await call(env, fresh, 'search_notes', { query: 'anything' });
    expect(s.isError).toBeUndefined();
  });

  // ── Vector 6 — audit = scoreboard: every write leaves a reconstructable row ───────────────────────
  it('V6: a successful write is audited allow with the agent grantId + note resource', async () => {
    const { token, grantId } = await mintAgentToken(env, ownerA, passA, { write: WRITE_ALL });
    const created = await call(env, token, 'create_note', { title: 'audited', text: 'x' });
    const id = created.structuredContent.note.id;
    await call(env, token, 'trash_note', { id });

    const mcp = auditRows(raw, accountA).filter((r) => r.surface === 'mcp');
    const creates = mcp.filter((r) => r.action === 'create' && r.result === 'allow');
    const trashes = mcp.filter((r) => r.action === 'delete' && r.result === 'allow');
    expect(creates.length).toBe(1);
    expect(trashes.length).toBe(1);
    expect(creates[0]!.credentialRef).toBe(grantId);
    expect(creates[0]!.detail).toBe('create_note'); // the tool name is on the trail
    expect(trashes[0]!.detail).toBe('trash_note');
  });

  // ── Vector 7 — unified clamp + step-up integrity ──────────────────────────────────────────────────
  it('V7: the `scope` body field cannot widen a grant past the explicit `write` opt-in', async () => {
    // Request write/create/delete/share via `scope` but DO NOT set the `write` opt-in → stays read-only.
    const res = await app.request('/api/agent-tokens', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerA}` },
      body: JSON.stringify({ password: passA, scope: ['read', 'write', 'create', 'delete', 'share'] }),
    }, env);
    const { token, scope } = await res.json();
    expect(scope).toEqual(['read']); // only read survives; no write, no share
    const w = await call(env, token, 'create_note', { title: 'x' });
    expect(w.isError).toBe(true);
  });

  it('V7: `share` is NEVER granted, even on a full write opt-in (agent can\'t manage tokens)', async () => {
    const { token, scope } = await mintAgentToken(env, ownerA, passA, { write: WRITE_ALL });
    expect(scope).not.toContain('share');
    // A write token cannot mint/list/revoke tokens (those routes require op `share` → 403).
    const listTokens = await app.request('/api/agent-tokens', {
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(listTokens.status).toBe(403);
  });

  it('V7: minting a write token requires step-up — no password ⇒ 401, no grant', async () => {
    const before = raw.prepare('SELECT COUNT(*) AS n FROM grants').get() as { n: number };
    const res = await app.request('/api/agent-tokens', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerA}` },
      body: JSON.stringify({ write: WRITE_ALL }), // no password
    }, env);
    expect(res.status).toBe(401);
    const after = raw.prepare('SELECT COUNT(*) AS n FROM grants').get() as { n: number };
    expect(after.n).toBe(before.n); // fail-closed — nothing minted
  });

  // ── Vector 8 — misc adversarial edges ─────────────────────────────────────────────────────────────
  it('V8: an agent cannot silently UN-trash a note (no tool clears sys:trashedAt)', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, { write: WRITE_ALL });
    const id = (await call(env, token, 'create_note', { title: 'x' })).structuredContent.note.id;
    await call(env, token, 'trash_note', { id });
    // update_note (title/body only) + set_property (user keys only) can't touch sys:trashedAt → stays trashed.
    await call(env, token, 'update_note', { id, title: 'edited while trashed' });
    await call(env, token, 'set_property', { id, key: 'note', value: { type: 'text', value: 'still here' } });
    const note = await getNote(env, token, id);
    expect(note.properties['sys:trashedAt']).toBeDefined(); // restore stays a USER-only action (Trash view)
  });

  it('V8: note ids are server-owned — an agent-supplied id on create is rejected (can\'t target/overwrite)', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, { write: WRITE_ALL });
    // create_note has no `id` arg; a strict schema rejects one, so an agent can never pick/overwrite an id.
    const r = await rawCall(env, token, 'create_note', { id: DUMMY_NOTE, title: 'x' });
    expect(r.error?.code).toBe(-32602);
  });
});
