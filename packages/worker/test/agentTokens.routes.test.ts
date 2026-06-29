/**
 * Route + chokepoint tests for the agent-token surface (llm-mcp-integration.md §5): POST/GET/DELETE
 * /api/agent-tokens. This is externally-reachable CREDENTIAL machinery, so the bar is strict — the tests
 * pin the security contract, not just the happy path:
 *   - mint inserts a correctly-shaped grant (principalKind='agent', non-expiring, principalId = OWNER
 *     accountId), returns the raw token ONCE, and persists ONLY the hash;
 *   - scope is CLAMPED read-only at mint (write/create/delete/share dropped, fail-closed);
 *   - list excludes the token + is account-scoped;
 *   - revoke sets revokedAt; BOLA: account B can neither see nor revoke account A's token (404);
 *   - an agent token resolves through resolvePrincipal to a capability-method principal where can(read)
 *     ALLOWS and can(write) DENIES, and an agent token can NEVER mint/list/revoke tokens itself.
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
import { createAuthStore } from '../src/db/authStore.js';
import { d1Adapter } from '../src/db/schema.js';
import { hashToken } from '../src/authCrypto.js';
import { resolvePrincipal, can } from '../src/auth.js';
import type { AppContext } from '../src/context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql',
  '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql',
  '0013_agent-token-label.sql',
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

const AUD = 'deltos.agentTokens.routes';
const makeEnv = (raw: Database.Database): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, AUTH_PEPPER: 'agent-tokens-pepper' } as unknown as Env);

const post = (env: Env, path: string, body: unknown, token: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }, env);
const get = (env: Env, path: string, token: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${token}` } }, env);
const del = (env: Env, path: string, token: string) =>
  app.request(path, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }, env);

interface MintResponse {
  token: string;
  grantId: string;
  label: string | null;
  scope: string[];
  resourceKind: string;
  resourceId: string | null;
  createdAt: string;
}

/** A minimal AppContext that only exposes the Authorization header — all resolvePrincipal needs (given a store). */
function ctxWithBearer(token: string): AppContext {
  return {
    req: { header: (name: string) => (name === 'Authorization' ? `Bearer ${token}` : undefined) },
  } as unknown as AppContext;
}

const NOTEBOOK = '11111111-1111-4111-8111-111111111111';

describe('agent tokens — mint / list / revoke (route + chokepoint)', () => {
  let env: Env;
  let raw: Database.Database;
  let token: string; // account A owner session bearer
  let accountId: string;

  beforeEach(async () => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    ({ token, accountId } = await signupToken(env, 'agent-owner', 'agent-tokens-password'));
  });

  it('mint inserts a correct grant shape, returns the raw token ONCE, stores ONLY the hash', async () => {
    const res = await post(env, '/api/agent-tokens', { label: 'Claude Desktop' }, token);
    expect(res.status).toBe(201);
    const body = (await res.json()) as MintResponse;

    expect(body.token).toMatch(/^dltos_agent_/);
    expect(body.label).toBe('Claude Desktop');
    expect(body.resourceKind).toBe('workspace');
    expect(body.resourceId).toBeNull();
    expect(body.scope.sort()).toEqual(['read', 'search']); // default read-only surface

    // The persisted grant: principalKind='agent', principalId = OWNER accountId, non-expiring, hash-only.
    const grow = raw
      .prepare('SELECT principalKind, principalId, expiresAtMs, revokedAt, tokenHash, scope FROM grants WHERE grantId = ?')
      .get(body.grantId) as { principalKind: string; principalId: string; expiresAtMs: number | null; revokedAt: string | null; tokenHash: string; scope: string };
    expect(grow.principalKind).toBe('agent');
    expect(grow.principalId).toBe(accountId); // scopes to the OWNER's account — NOT a body field
    expect(grow.expiresAtMs).toBeNull(); // non-expiring
    expect(grow.revokedAt).toBeNull();
    expect(JSON.parse(grow.scope).sort()).toEqual(['read', 'search']);

    // Only the HASH is stored — never the raw token; and the stored hash matches SHA-256(token).
    expect(grow.tokenHash).toBe(hashToken(body.token));
    expect(grow.tokenHash).not.toContain(body.token);
    const rawTokenLeak = raw.prepare('SELECT COUNT(*) AS n FROM grants WHERE tokenHash = ?').get(body.token) as { n: number };
    expect(rawTokenLeak.n).toBe(0); // the raw token is nowhere in the column
  });

  it('CLAMP: write/create/delete/share scopes are dropped at mint (fail-closed read-only)', async () => {
    const res = await post(env, '/api/agent-tokens', { scope: ['read', 'write', 'create', 'delete', 'share'] }, token);
    expect(res.status).toBe(201);
    const body = (await res.json()) as MintResponse;
    expect(body.scope).toEqual(['read']); // only the read-only verb survived
  });

  it('mint with notebookId scopes the grant to that notebook', async () => {
    const res = await post(env, '/api/agent-tokens', { notebookId: NOTEBOOK, scope: ['read'] }, token);
    expect(res.status).toBe(201);
    const body = (await res.json()) as MintResponse;
    expect(body.resourceKind).toBe('notebook');
    expect(body.resourceId).toBe(NOTEBOOK);
  });

  it('list returns active tokens WITHOUT the token/hash, and is account-scoped', async () => {
    await post(env, '/api/agent-tokens', { label: 'one' }, token);
    await post(env, '/api/agent-tokens', { label: 'two' }, token);

    const res = await get(env, '/api/agent-tokens', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Array<Record<string, unknown>> };
    expect(body.tokens).toHaveLength(2);
    for (const t of body.tokens) {
      expect(t).not.toHaveProperty('token');
      expect(t).not.toHaveProperty('tokenHash');
      expect(t).toHaveProperty('grantId');
      expect(t).toHaveProperty('label');
      expect(t).toHaveProperty('scope');
    }

    // Account B sees NONE of account A's tokens.
    const { token: tokenB } = await signupToken(env, 'agent-owner-B', 'agent-tokens-password-B');
    const resB = await get(env, '/api/agent-tokens', tokenB);
    expect(((await resB.json()) as { tokens: unknown[] }).tokens).toHaveLength(0);
  });

  it('revoke sets revokedAt and drops the token from the active list', async () => {
    const minted = (await (await post(env, '/api/agent-tokens', { label: 'doomed' }, token)).json()) as MintResponse;

    const res = await del(env, `/api/agent-tokens/${minted.grantId}`, token);
    expect(res.status).toBe(200);

    const row = raw.prepare('SELECT revokedAt FROM grants WHERE grantId = ?').get(minted.grantId) as { revokedAt: string | null };
    expect(row.revokedAt).not.toBeNull();

    const list = (await (await get(env, '/api/agent-tokens', token)).json()) as { tokens: unknown[] };
    expect(list.tokens).toHaveLength(0); // active list excludes the revoked token
  });

  it('🚨 BOLA: account B cannot see or revoke account A\'s token (404, A\'s token survives)', async () => {
    const minted = (await (await post(env, '/api/agent-tokens', { label: 'A-secret' }, token)).json()) as MintResponse;
    const { token: tokenB } = await signupToken(env, 'agent-attacker', 'agent-tokens-password-B');

    // B cannot revoke A's grant — 404 (not 403: no existence disclosure).
    const res = await del(env, `/api/agent-tokens/${minted.grantId}`, tokenB);
    expect(res.status).toBe(404);

    // A's token is UNTOUCHED — still active.
    const row = raw.prepare('SELECT revokedAt FROM grants WHERE grantId = ?').get(minted.grantId) as { revokedAt: string | null };
    expect(row.revokedAt).toBeNull();
    const list = (await (await get(env, '/api/agent-tokens', token)).json()) as { tokens: unknown[] };
    expect(list.tokens).toHaveLength(1);
  });

  it('revoking an unknown grantId is 404', async () => {
    const res = await del(env, '/api/agent-tokens/does-not-exist', token);
    expect(res.status).toBe(404);
  });

  it('a minted agent token resolves to a CAPABILITY principal: can(read) ALLOWS, can(write) DENIES', async () => {
    const minted = (await (await post(env, '/api/agent-tokens', { scope: ['read', 'search'] }, token)).json()) as MintResponse;

    const store = createAuthStore(d1Adapter(env.DB));
    const principal = await resolvePrincipal(ctxWithBearer(minted.token), store);

    expect(principal.kind).toBe('agent');
    expect(principal.verification.method).toBe('capability');
    expect(principal.id).toBe(accountId); // scopes data to the OWNER's account

    expect(await can(principal, 'read', { kind: 'workspace' })).toBe(true);
    expect(await can(principal, 'search', { kind: 'workspace' })).toBe(true);
    expect(await can(principal, 'write', { kind: 'workspace' })).toBe(false);
    expect(await can(principal, 'create', { kind: 'workspace' })).toBe(false);
    expect(await can(principal, 'delete', { kind: 'workspace' })).toBe(false);
    expect(await can(principal, 'share', { kind: 'workspace' })).toBe(false); // can't manage tokens
  });

  it('an agent token can NEVER mint / list / revoke tokens (the routes require op share → 403)', async () => {
    const minted = (await (await post(env, '/api/agent-tokens', {}, token)).json()) as MintResponse;
    const agentBearer = minted.token;

    const mintRes = await post(env, '/api/agent-tokens', { label: 'nested' }, agentBearer);
    expect(mintRes.status).toBe(403);
    const listRes = await get(env, '/api/agent-tokens', agentBearer);
    expect(listRes.status).toBe(403);
    const revokeRes = await del(env, `/api/agent-tokens/${minted.grantId}`, agentBearer);
    expect(revokeRes.status).toBe(403);

    // And the owner's token is untouched by the failed agent revoke attempt.
    const row = raw.prepare('SELECT revokedAt FROM grants WHERE grantId = ?').get(minted.grantId) as { revokedAt: string | null };
    expect(row.revokedAt).toBeNull();
  });
});
