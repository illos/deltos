/**
 * SECURITY AUDIT LOG tests (ROAD-0005 P3). The append-only who/what/where trail wired into the two access
 * chokepoints (REST `guard()` + MCP `tools/call`) and the credential-lifecycle handlers (login, agent-token
 * mint/revoke, session revoke). The bar:
 *   - the helper writes ONE well-formed AE datapoint per event, with the positional blob schema intact;
 *   - both ALLOW and DENY decisions are recorded at each access chokepoint;
 *   - lifecycle events (login success/failure, mint, mint-step-up-fail, revoke, session revoke) are recorded;
 *   - agent (MCP) access is tagged `surface:'mcp'` + `principalKind:'agent'` so it's queryable on its own;
 *   - FAIL-SOFT: a throwing `writeDataPoint` never breaks the request; an UNBOUND binding is a silent no-op.
 *
 * Self-contained harness (repo style): better-sqlite3 → D1 shim + the real Hono app + an AUDIT capture stub.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { signupToken } from './helpers/passwordToken.js';
import { createAuthStore } from '../src/db/authStore.js';
import { d1Adapter } from '../src/db/schema.js';
import { credentialRefOf } from '../src/audit.js';
import type { RequestPrincipal } from '@deltos/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql', '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql', '0013_agent-token-label.sql', '0014_grant-family-link.sql',
  '0015_audit-log.sql',
  '0016_usage-counter.sql',
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

/** The captured datapoints + the AnalyticsEngineDataset stub that records them. */
interface Captured { indexes?: string[]; blobs?: unknown[]; doubles?: number[] }
function captureAudit(opts: { throws?: boolean } = {}) {
  const points: Captured[] = [];
  const dataset = {
    writeDataPoint(p: Captured) {
      if (opts.throws) throw new Error('AE down');
      points.push(p);
    },
  } as unknown as AnalyticsEngineDataset;
  return { dataset, points };
}

/** Decode a datapoint by the positional blob schema in audit.ts (blob1..blob15). */
function decode(p: Captured) {
  const b = (p.blobs ?? []) as string[];
  return {
    surface: b[0], action: b[1], result: b[2], principalKind: b[3], accountId: b[4],
    credentialRef: b[5], resourceKind: b[6], resourceId: b[7], ip: b[8], country: b[9],
    colo: b[10], userAgent: b[11], method: b[12], path: b[13], detail: b[14],
    index: p.indexes?.[0], count: p.doubles?.[0],
  };
}

const AUD = 'deltos.audit';
const OWNER_PW = 'audit-owner-password';
function makeEnv(raw: Database.Database, audit?: AnalyticsEngineDataset): Env {
  return {
    DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, AUTH_PEPPER: 'audit-pepper',
    ...(audit ? { AUDIT: audit } : {}),
  } as unknown as Env;
}

const post = (env: Env, path: string, body: unknown, token?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }, env);
const del = (env: Env, path: string, token: string) =>
  app.request(path, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }, env);

const rpc = (env: Env, payload: unknown, token?: string) =>
  app.request('/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  }, env);

describe('P3 audit — credentialRefOf', () => {
  it('extracts the grantId from a grant-token / capability principal, null otherwise', () => {
    const g = { kind: 'owner', id: 'a', verification: { method: 'grant-token', grantId: 'gid-1' } } as RequestPrincipal;
    const cap = { kind: 'agent', id: 'a', verification: { method: 'capability', grantId: 'gid-2' } } as RequestPrincipal;
    const dev = { kind: 'owner', id: 'a', verification: { method: 'unverified' } } as RequestPrincipal;
    expect(credentialRefOf(g)).toBe('gid-1');
    expect(credentialRefOf(cap)).toBe('gid-2');
    expect(credentialRefOf(dev)).toBeNull();
  });
});

describe('P3 audit — lifecycle + chokepoint events', () => {
  let raw: Database.Database;

  beforeEach(() => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
  });

  it('records a successful LOGIN as auth/login/allow with the account', async () => {
    const seedEnv = makeEnv(raw);
    await signupToken(seedEnv, 'login-ok', OWNER_PW);
    const { dataset, points } = captureAudit();
    const env = makeEnv(raw, dataset);
    const res = await post(env, '/api/auth/login', { username: 'login-ok', password: OWNER_PW });
    expect(res.status).toBe(200);
    const ev = points.map(decode).find((e) => e.action === 'login' && e.result === 'allow');
    expect(ev).toBeDefined();
    expect(ev!.surface).toBe('auth');
    expect(ev!.principalKind).toBe('owner');
    expect(ev!.accountId.length).toBeGreaterThan(0);
    expect(ev!.detail).toBe('password');
    expect(ev!.count).toBe(1);
  });

  it('records a FAILED login (wrong password) as auth/login/deny — and the response stays a uniform 401', async () => {
    const seedEnv = makeEnv(raw);
    await signupToken(seedEnv, 'login-bad', OWNER_PW);
    const { dataset, points } = captureAudit();
    const env = makeEnv(raw, dataset);
    const res = await post(env, '/api/auth/login', { username: 'login-bad', password: 'wrong-password' });
    expect(res.status).toBe(401);
    const ev = points.map(decode).find((e) => e.action === 'login' && e.result === 'deny');
    expect(ev).toBeDefined();
    expect(ev!.detail).toBe('invalid-credentials');
  });

  it('records an agent-token MINT as auth/token.mint/allow with the NEW grantId as the credentialRef', async () => {
    const seedEnv = makeEnv(raw);
    const { token } = await signupToken(seedEnv, 'mint-owner', OWNER_PW);
    const { dataset, points } = captureAudit();
    const env = makeEnv(raw, dataset);
    const res = await post(env, '/api/agent-tokens', { password: OWNER_PW, label: 'x' }, token);
    expect(res.status).toBe(201);
    const grantId = ((await res.json()) as { grantId: string }).grantId;
    const ev = points.map(decode).find((e) => e.action === 'token.mint' && e.result === 'allow');
    expect(ev).toBeDefined();
    expect(ev!.surface).toBe('auth');
    expect(ev!.credentialRef).toBe(grantId);
    expect(ev!.detail).toBe('agent-token');
  });

  it('records a mint STEP-UP failure (wrong password) as auth/token.mint/deny', async () => {
    const seedEnv = makeEnv(raw);
    const { token } = await signupToken(seedEnv, 'mint-stepup', OWNER_PW);
    const { dataset, points } = captureAudit();
    const env = makeEnv(raw, dataset);
    const res = await post(env, '/api/agent-tokens', { password: 'not-it' }, token);
    expect(res.status).toBe(401);
    const ev = points.map(decode).find((e) => e.action === 'token.mint' && e.result === 'deny');
    expect(ev).toBeDefined();
    expect(ev!.detail).toBe('step-up-failed');
  });

  it('records an agent-token REVOKE as auth/token.revoke with the target grantId in detail', async () => {
    const seedEnv = makeEnv(raw);
    const { token } = await signupToken(seedEnv, 'revoke-owner', OWNER_PW);
    const minted = (await (await post(seedEnv, '/api/agent-tokens', { password: OWNER_PW }, token)).json()) as { grantId: string };
    const { dataset, points } = captureAudit();
    const env = makeEnv(raw, dataset);
    const res = await del(env, `/api/agent-tokens/${minted.grantId}`, token);
    expect(res.status).toBe(200);
    const ev = points.map(decode).find((e) => e.action === 'token.revoke');
    expect(ev).toBeDefined();
    expect(ev!.detail).toBe(minted.grantId);
  });

  it('records a SESSION revoke as auth/session.revoke', async () => {
    const seedEnv = makeEnv(raw);
    const { token, accountId } = await signupToken(seedEnv, 'sess-owner', OWNER_PW);
    // Seed a real refresh session for this account (signup mints no durable session until recovery is
    // established) so the revoke endpoint has a family to kill → revoked>0 → the audit line fires.
    const store = createAuthStore(d1Adapter(seedEnv.DB));
    const familyId = 'fam-audit-test';
    await store.insertRefreshSession({
      tokenHash: 'hash-audit-test', familyId, accountId,
      issuedAtMs: Date.now(), expiresAtMs: Date.now() + 1_000_000, label: 'test device',
    });
    const { dataset, points } = captureAudit();
    const env = makeEnv(raw, dataset);
    const res = await del(env, `/api/auth/sessions/${familyId}`, token);
    expect(res.status).toBe(200);
    const ev = points.map(decode).find((e) => e.action === 'session.revoke');
    expect(ev).toBeDefined();
    expect(ev!.detail).toBe(familyId);
  });

  it('tags MCP tool access surface:mcp / principalKind:agent (allow) — the connected-AI trail', async () => {
    const seedEnv = makeEnv(raw);
    const { token } = await signupToken(seedEnv, 'mcp-owner', OWNER_PW);
    const agent = (await (await post(seedEnv, '/api/agent-tokens', { password: OWNER_PW }, token)).json()) as { token: string };
    const { dataset, points } = captureAudit();
    const env = makeEnv(raw, dataset);
    const res = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_notebooks', arguments: {} } }, agent.token);
    expect(res.status).toBe(200);
    const ev = points.map(decode).find((e) => e.surface === 'mcp' && e.result === 'allow');
    expect(ev).toBeDefined();
    expect(ev!.principalKind).toBe('agent');
    expect(ev!.detail).toBe('list_notebooks');
  });

  it('records a REST guard DENY when an agent token attempts a share-gated op (surface:rest, deny)', async () => {
    const seedEnv = makeEnv(raw);
    const { token } = await signupToken(seedEnv, 'rest-deny', OWNER_PW);
    const agent = (await (await post(seedEnv, '/api/agent-tokens', { password: OWNER_PW }, token)).json()) as { token: string };
    const { dataset, points } = captureAudit();
    const env = makeEnv(raw, dataset);
    // An agent token has no 'share' scope → listing agent tokens 403s at the guard chokepoint.
    const res = await app.request('/api/agent-tokens', { headers: { Authorization: `Bearer ${agent.token}` } }, env);
    expect(res.status).toBe(403);
    const ev = points.map(decode).find((e) => e.surface === 'rest' && e.result === 'deny');
    expect(ev).toBeDefined();
    expect(ev!.principalKind).toBe('agent');
  });

  it('FAIL-SOFT: a throwing writeDataPoint does NOT break the request', async () => {
    const seedEnv = makeEnv(raw);
    await signupToken(seedEnv, 'failsoft', OWNER_PW);
    const { dataset } = captureAudit({ throws: true });
    const env = makeEnv(raw, dataset);
    const res = await post(env, '/api/auth/login', { username: 'failsoft', password: OWNER_PW });
    expect(res.status).toBe(200); // request succeeds even though every audit write throws
  });

  it('NO-OP: an UNBOUND AUDIT binding leaves requests fully functional', async () => {
    const env = makeEnv(raw); // no AUDIT
    const r = await signupToken(env, 'unbound', OWNER_PW);
    expect(r.token.length).toBeGreaterThan(0);
    const login = await post(env, '/api/auth/login', { username: 'unbound', password: OWNER_PW });
    expect(login.status).toBe(200);
  });
});

/**
 * The D1 PROJECTION + the user-facing read route (GET /api/audit/recent). The projection takes only the
 * security-meaningful subset (auth + mcp + any deny) — NOT the owner's routine rest-allow chatter — and
 * the read route is owner-only (op:'share' → agent tokens 403) and account-scoped (BOLA).
 */
describe('P3 audit — D1 projection + the "Account activity" read route', () => {
  let raw: Database.Database;
  beforeEach(() => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
  });

  const recent = (env: Env, token: string) =>
    app.request('/api/audit/recent', { headers: { Authorization: `Bearer ${token}` } }, env);

  interface ActivityEvent {
    id: number; ts: string; surface: string; action: string; result: string;
    principalKind: string; resourceKind: string | null; detail: string | null;
  }
  const eventsOf = async (res: Response) =>
    ((await res.json()) as { events: ActivityEvent[] }).events;

  it('projects a LOGIN into the feed and the owner can read it back (newest-first, account-scoped)', async () => {
    const env = makeEnv(raw); // AUDIT unbound is fine — the D1 projection does not depend on AE
    const { token } = await signupToken(env, 'feed-owner', OWNER_PW);
    await post(env, '/api/auth/login', { username: 'feed-owner', password: OWNER_PW });
    const res = await recent(env, token);
    expect(res.status).toBe(200);
    const events = await eventsOf(res);
    const login = events.find((e) => e.action === 'login' && e.result === 'allow');
    expect(login).toBeDefined();
    expect(login!.surface).toBe('auth');
    // The response carries no secret (no credentialRef/token field leaks through the projection view).
    expect(JSON.stringify(events)).not.toContain('credentialRef');
  });

  it('projects agent MINT + the agent\'s MCP access into the OWNER feed, but NOT routine rest-allow', async () => {
    const env = makeEnv(raw);
    const { token } = await signupToken(env, 'feed-mcp', OWNER_PW);
    const agent = (await (await post(env, '/api/agent-tokens', { password: OWNER_PW }, token)).json()) as { token: string };
    // An agent reads via MCP (projected) ...
    await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_notebooks', arguments: {} } }, agent.token);
    // ... and the owner makes a routine rest-allow call (listing tokens) — must NOT be projected.
    await app.request('/api/agent-tokens', { headers: { Authorization: `Bearer ${token}` } }, env);

    const events = await eventsOf(await recent(env, token));
    expect(events.some((e) => e.action === 'token.mint' && e.result === 'allow')).toBe(true);
    expect(events.some((e) => e.surface === 'mcp')).toBe(true);
    // The owner's own rest-allow share/read traffic stays AE-only — never in the readable feed.
    expect(events.some((e) => e.surface === 'rest' && e.result === 'allow')).toBe(false);
  });

  it('projects a DENY (failed login on a known account) so the owner can catch it live', async () => {
    const env = makeEnv(raw);
    const { token } = await signupToken(env, 'feed-deny', OWNER_PW);
    await post(env, '/api/auth/login', { username: 'feed-deny', password: 'wrong-password' });
    const events = await eventsOf(await recent(env, token));
    expect(events.some((e) => e.action === 'login' && e.result === 'deny')).toBe(true);
  });

  it('BOLA: account B never sees account A\'s activity', async () => {
    const env = makeEnv(raw);
    await signupToken(env, 'feed-a', OWNER_PW);
    await post(env, '/api/auth/login', { username: 'feed-a', password: OWNER_PW });
    const { token: tokenB } = await signupToken(env, 'feed-b', OWNER_PW);
    await post(env, '/api/auth/login', { username: 'feed-b', password: OWNER_PW });
    const events = await eventsOf(await recent(env, tokenB));
    // Both A and B logged in (one allow-login projected each, scoped to its own account). B's feed must
    // contain EXACTLY its own (1) — if account-scoping leaked, A's would show too and the count would be 2.
    expect(events.filter((e) => e.action === 'login' && e.result === 'allow').length).toBe(1);
  });

  it('OWNER-ONLY: an agent token is FORBIDDEN from reading the audit feed (op:share excludes agents)', async () => {
    const env = makeEnv(raw);
    const { token } = await signupToken(env, 'feed-guard', OWNER_PW);
    const agent = (await (await post(env, '/api/agent-tokens', { password: OWNER_PW }, token)).json()) as { token: string };
    const res = await recent(env, agent.token);
    expect(res.status).toBe(403);
  });
});
