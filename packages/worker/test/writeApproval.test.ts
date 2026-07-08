/**
 * Agent bulk-write APPROVAL (alert-banner-system.md §6) — the backend + shared half. Covers the full,
 * security-shaped contract:
 *   - `request_write_approval` (read-scope MCP tool) creates a token-scoped PENDING record; a READ-ONLY token
 *     can ask; it does NOT charge the mcpWrite cap; `check_write_approval` polls the outcome (BOLA-scoped);
 *   - the EFFECTIVE write cap = base 100 + an ACTIVE approved grant's extra, ONLY within a token+day box, and
 *     EXACTLY 100 otherwise (the regression guard);
 *   - the REST Approve/Deny mutate the row + audit as a security event; cross-account act → 404 (BOLA);
 *   - the sync-pull carries the actionable alert while pending and DROPS it once approved / expired / denied;
 *   - a pending request self-expires at 30 min.
 *
 * Self-contained harness: better-sqlite3 → D1 shim + the real Hono app + the shared signupToken helper.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { signupToken } from './helpers/passwordToken.js';
import { allMigrations } from './helpers/migrations.js';
import { createAuthStore } from '../src/db/authStore.js';
import { d1Adapter } from '../src/db/schema.js';
import { effectiveWriteCap } from '../src/usage.js';
import { dayBucket } from '../src/abusePolicy.js';
import type { AgentWriteOpt } from '@deltos/shared';

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

const AUD = 'deltos.write.approval';
const makeEnv = (raw: Database.Database): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, AUTH_PEPPER: 'approval-pepper' } as unknown as Env);

interface JsonRpcResult { jsonrpc: string; id: unknown; result?: any; error?: { code: number; message: string } }

const rpc = (env: Env, payload: unknown, token?: string) =>
  app.request('/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  }, env);

async function call(env: Env, token: string, name: string, args: unknown): Promise<JsonRpcResult['result']> {
  const res = await rpc(env, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, token);
  return ((await res.json()) as JsonRpcResult).result;
}

const WRITE_ALL: AgentWriteOpt = { create: true, update: true, trash: true };

/** Mint an agent token (optionally write-capable); returns the bearer + its grantId + tokenGroupId. */
async function mintAgentToken(
  env: Env, ownerToken: string, ownerPassword: string, raw: Database.Database, write?: AgentWriteOpt,
): Promise<{ token: string; grantId: string; tokenGroupId: string; accountId: string }> {
  const res = await app.request('/api/agent-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ label: 'approval-test', password: ownerPassword, ...(write ? { write } : {}) }),
  }, env);
  if (res.status !== 201) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string; tokenId: string; resources: Array<{ grantId: string }> };
  const grantId = body.resources[0].grantId;
  const row = raw.prepare('SELECT principalId, tokenGroupId FROM grants WHERE grantId = ?').get(grantId) as { principalId: string; tokenGroupId: string };
  return { token: body.token, grantId, tokenGroupId: row.tokenGroupId, accountId: row.principalId };
}

/** GET /api/sync/pull → the parsed response (alerts included). */
async function pull(env: Env, token: string, cursor = 0): Promise<any> {
  const res = await app.request(`/api/sync/pull?cursor=${cursor}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, env);
  return res.json();
}

describe('agent bulk-write approval (backend + shared)', () => {
  let env: Env;
  let raw: Database.Database;
  let ownerA: string;
  let passA: string;

  beforeEach(async () => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    passA = 'approval-owner-password';
    ({ token: ownerA } = await signupToken(env, 'approval-owner', passA));
  });

  // --- request_write_approval (read-scope tool) -----------------------------------------------------

  it('request_write_approval creates a token-scoped PENDING record (a read-only token can ask)', async () => {
    const { token, tokenGroupId, accountId } = await mintAgentToken(env, ownerA, passA, raw); // NO write opt-in
    const r = await call(env, token, 'request_write_approval', { count: 430, reason: 'importing 430 notes from UpNote' });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.status).toBe('pending');
    const approvalId = r.structuredContent.approvalId;
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/i);
    // The row is durable, pending, and scoped to THIS token + account.
    const row = raw.prepare('SELECT * FROM agentWriteApprovals WHERE id = ?').get(approvalId) as any;
    expect(row.status).toBe('pending');
    expect(row.requestedCount).toBe(430);
    expect(row.reason).toBe('importing 430 notes from UpNote');
    expect(row.tokenGroupId).toBe(tokenGroupId);
    expect(row.accountId).toBe(accountId);
    // Self-expiry ≈ 30 min out.
    expect(row.expiresAt - row.createdAt).toBe(30 * 60 * 1000);
  });

  it('request_write_approval does NOT consume the mcpWrite cap (it is read-scope)', async () => {
    const { token, accountId } = await mintAgentToken(env, ownerA, passA, raw);
    await call(env, token, 'request_write_approval', { count: 10, reason: 'x' });
    const today = dayBucket(Date.now());
    const counter = raw.prepare('SELECT count FROM usageCounter WHERE accountId=? AND metric=? AND dayBucket=?')
      .get(accountId, 'mcpWrite', today) as { count: number } | undefined;
    expect(counter).toBeUndefined(); // no mcpWrite charge for a read-scope tool
  });

  it('request_write_approval rejects a non-positive count / empty reason at the boundary', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, raw);
    const bad = await rpc(env, {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'request_write_approval', arguments: { count: 0, reason: 'x' } },
    }, token).then((r) => r.json()) as JsonRpcResult;
    expect(bad.error?.code).toBe(-32602);
    const noReason = await rpc(env, {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'request_write_approval', arguments: { count: 5, reason: '   ' } },
    }, token).then((r) => r.json()) as JsonRpcResult;
    expect(noReason.error?.code).toBe(-32602);
  });

  it('check_write_approval returns status for the caller (and 404s an unknown id)', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, raw);
    const req = await call(env, token, 'request_write_approval', { count: 5, reason: 'x' });
    const chk = await call(env, token, 'check_write_approval', { approvalId: req.structuredContent.approvalId });
    expect(chk.structuredContent.status).toBe('pending');
    const missing = await call(env, token, 'check_write_approval', { approvalId: '00000000-0000-4000-8000-000000000000' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/not found/i);
  });

  // --- effective write cap: default-100 regression + count/time/token boxing ------------------------

  it('effectiveWriteCap is EXACTLY 100 with no active approval (regression guard)', async () => {
    const { tokenGroupId, accountId } = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    const store = createAuthStore(d1Adapter(env.DB));
    const cap = await effectiveWriteCap(store, accountId, tokenGroupId, dayBucket(Date.now()));
    expect(cap).toBe(100);
  });

  it('an APPROVED grant lifts the effective cap by grantedCount — but only within the token+day box', async () => {
    const { token, tokenGroupId, accountId } = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    const store = createAuthStore(d1Adapter(env.DB));
    const today = dayBucket(Date.now());

    // Request → Approve via the REST endpoint (the human path).
    const req = await call(env, token, 'request_write_approval', { count: 430, reason: 'bulk import' });
    const approvalId = req.structuredContent.approvalId;
    const appr = await app.request(`/api/alerts/${approvalId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerA}` },
      body: JSON.stringify({ actionId: 'approve' }),
    }, env);
    expect(appr.status).toBe(200);
    expect(((await appr.json()) as any).grantedCount).toBe(430);

    // Same token, same day → lifted to 530.
    expect(await effectiveWriteCap(store, accountId, tokenGroupId, today)).toBe(530);
    // TIME box: a different day → back to 100 (auto-revert, no cleanup job).
    expect(await effectiveWriteCap(store, accountId, tokenGroupId, '1999-01-01')).toBe(100);
    // TOKEN box: a DIFFERENT token of the SAME account is unaffected → 100.
    const other = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    expect(await effectiveWriteCap(store, accountId, other.tokenGroupId, today)).toBe(100);
  });

  it('end-to-end: a write blocked at cap succeeds after Approve, still count-boxed to the lift', async () => {
    const { token, accountId } = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    const today = dayBucket(Date.now());
    // Seed the write counter at the base cap (100 already spent today).
    raw.prepare('INSERT INTO usageCounter (accountId, metric, dayBucket, count, updatedAt) VALUES (?,?,?,?,?)')
      .run(accountId, 'mcpWrite', today, 100, new Date().toISOString());

    // Blocked (message now points the agent at request_write_approval).
    const blocked = await call(env, token, 'create_note', { title: 'over cap' });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toMatch(/request_write_approval/);

    // Ask → Approve for 2 extra.
    const req = await call(env, token, 'request_write_approval', { count: 2, reason: 'two more' });
    await app.request(`/api/alerts/${req.structuredContent.approvalId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerA}` },
      body: JSON.stringify({ actionId: 'approve' }),
    }, env);

    // Two writes now go through (cap raised to 102, counter at 100 → 101, 102).
    expect((await call(env, token, 'create_note', { title: 'one' })).structuredContent.status).toBe('applied');
    expect((await call(env, token, 'create_note', { title: 'two' })).structuredContent.status).toBe('applied');
    // The third is COUNT-boxed out (102 reached) — the lift is a ceiling raise, not a bypass.
    const third = await call(env, token, 'create_note', { title: 'three' });
    expect(third.isError).toBe(true);
    expect(third.content[0].text).toMatch(/daily write limit/i);
  });

  // --- REST Approve/Deny: audit + BOLA --------------------------------------------------------------

  it('Approve is audited as a security event (approval.grant) projected to the D1 auditLog', async () => {
    const { token, accountId } = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    const req = await call(env, token, 'request_write_approval', { count: 9, reason: 'y' });
    await app.request(`/api/alerts/${req.structuredContent.approvalId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerA}` },
      body: JSON.stringify({ actionId: 'approve' }),
    }, env);
    const log = raw.prepare("SELECT action, result, principalKind FROM auditLog WHERE accountId=? AND action='approval.grant'").get(accountId) as any;
    expect(log?.result).toBe('allow');
    expect(log?.principalKind).toBe('owner');
  });

  it('Deny closes the request (audited approval.deny) and grants nothing', async () => {
    const { token, tokenGroupId, accountId } = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    const store = createAuthStore(d1Adapter(env.DB));
    const req = await call(env, token, 'request_write_approval', { count: 50, reason: 'z' });
    const approvalId = req.structuredContent.approvalId;
    const deny = await app.request(`/api/alerts/${approvalId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerA}` },
      body: JSON.stringify({ actionId: 'deny' }),
    }, env);
    expect(deny.status).toBe(200);
    expect(((await deny.json()) as any).status).toBe('denied');
    // No quota lift.
    expect(await effectiveWriteCap(store, accountId, tokenGroupId, dayBucket(Date.now()))).toBe(100);
    // The agent's poll learns it was denied.
    const chk = await call(env, token, 'check_write_approval', { approvalId });
    expect(chk.structuredContent.status).toBe('denied');
    const log = raw.prepare("SELECT action FROM auditLog WHERE accountId=? AND action='approval.deny'").get(accountId) as any;
    expect(log?.action).toBe('approval.deny');
  });

  it('🚨 BOLA: account B cannot approve account A\'s request (404, no lift)', async () => {
    const a = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    const req = await call(env, a.token, 'request_write_approval', { count: 100, reason: 'A private import' });
    const approvalId = req.structuredContent.approvalId;

    const { token: ownerB } = await signupToken(env, 'owner-b', 'owner-b-password');
    const res = await app.request(`/api/alerts/${approvalId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerB}` },
      body: JSON.stringify({ actionId: 'approve' }),
    }, env);
    expect(res.status).toBe(404); // indistinguishable from not-found — no cross-account oracle
    // A's request is untouched (still pending, no grant).
    const store = createAuthStore(d1Adapter(env.DB));
    expect(await effectiveWriteCap(store, a.accountId, a.tokenGroupId, dayBucket(Date.now()))).toBe(100);
  });

  it('an agent token (read/write, no share) can NEVER Approve — 403 at the chokepoint', async () => {
    const a = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    const req = await call(env, a.token, 'request_write_approval', { count: 5, reason: 'self-approve attempt' });
    const res = await app.request(`/api/alerts/${req.structuredContent.approvalId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ actionId: 'approve' }),
    }, env);
    expect(res.status).toBe(403); // op 'share' is owner-only; the agent can only ASK, never self-grant
  });

  // --- GET /api/alerts (banner feed) ----------------------------------------------------------------

  it('GET /api/alerts lists the pending actionable alert for the owner (banner feed)', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    await call(env, token, 'request_write_approval', { count: 42, reason: 'banner test' });
    const res = await app.request('/api/alerts', { headers: { Authorization: `Bearer ${ownerA}` } }, env);
    const body = (await res.json()) as any;
    expect(body.alerts).toHaveLength(1);
    const alert = body.alerts[0];
    expect(alert.kind).toBe('agent.writeApproval');
    expect(alert.severity).toBe('warning');
    expect(alert.message).toMatch(/~42 writes: banner test/);
    expect(alert.actions.map((x: any) => x.id)).toEqual(['approve', 'deny']);
    expect(alert.targetKind).toBe('writeApproval');
  });

  // --- sync-pull carrier: alert present while pending, absent once resolved/expired -----------------

  it('sync-pull carries the actionable alert while PENDING, then drops it once APPROVED', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    const req = await call(env, token, 'request_write_approval', { count: 430, reason: 'sync carrier' });
    const approvalId = req.structuredContent.approvalId;

    // Pull ON THE REQUESTING TOKEN → the alert is present (token-scoped projection).
    const pending = await pull(env, token);
    expect(Array.isArray(pending.alerts)).toBe(true);
    expect(pending.alerts.some((a: any) => a.targetId === approvalId)).toBe(true);
    expect(pending.alerts[0].message).toMatch(/~430 writes: sync carrier/);

    // Approve → the projection recomputes without it.
    await app.request(`/api/alerts/${approvalId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerA}` },
      body: JSON.stringify({ actionId: 'approve' }),
    }, env);
    const resolved = await pull(env, token);
    expect(resolved.alerts.some((a: any) => a.targetId === approvalId)).toBe(false);
  });

  it('sync-pull scopes actionable alerts to the REQUESTING token (token B never sees token A\'s ask)', async () => {
    const a = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    const b = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    const req = await call(env, a.token, 'request_write_approval', { count: 7, reason: 'A token ask' });
    // Token A sees it; token B (same account, different token) does not.
    expect((await pull(env, a.token)).alerts.some((x: any) => x.targetId === req.structuredContent.approvalId)).toBe(true);
    expect((await pull(env, b.token)).alerts.some((x: any) => x.targetId === req.structuredContent.approvalId)).toBe(false);
  });

  it('a PENDING request self-expires at 30 min — the alert drops off and the poll reads expired', async () => {
    const { token, accountId } = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    const req = await call(env, token, 'request_write_approval', { count: 5, reason: 'expiry' });
    const approvalId = req.structuredContent.approvalId;
    // Age the row past its 30-min expiry (simulate time passing).
    raw.prepare('UPDATE agentWriteApprovals SET createdAt = createdAt - ?, expiresAt = expiresAt - ? WHERE id = ?')
      .run(31 * 60 * 1000, 31 * 60 * 1000, approvalId);
    // The pull projection omits the lapsed pending request.
    expect((await pull(env, token)).alerts.some((a: any) => a.targetId === approvalId)).toBe(false);
    // The agent's poll reads it as expired (no mutation needed).
    const chk = await call(env, token, 'check_write_approval', { approvalId });
    expect(chk.structuredContent.status).toBe('expired');
    // And acting on an expired request is refused (409), so no late grant.
    const late = await app.request(`/api/alerts/${approvalId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerA}` },
      body: JSON.stringify({ actionId: 'approve' }),
    }, env);
    expect(late.status).toBe(409);
    expect(accountId).toBeTruthy();
  });

  // --- additive-safe pull contract ------------------------------------------------------------------

  it('the pull response always carries an alerts array (additive field) even with none pending', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, raw, WRITE_ALL);
    const body = await pull(env, token);
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(body.alerts).toHaveLength(0);
    // The pre-existing fields are unchanged (contract not weakened).
    expect(Array.isArray(body.notes)).toBe(true);
    expect(typeof body.nextCursor).toBe('number');
    expect(typeof body.hasMore).toBe('boolean');
  });
});
