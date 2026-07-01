/**
 * Route tests for the OAuth 2.1 provider discovery + Dynamic Client Registration surface
 * (docs/design/oauth-provider.md §1–2, lane A): the two `.well-known` metadata docs, `POST
 * /api/oauth/register`, and the `/api/mcp` 401 discovery pointer. Security-shaped, not just happy-path:
 * a plaintext non-loopback redirect_uri is refused at registration (it would leak a code over http).
 *
 * Self-contained harness: better-sqlite3 → D1 shim + the real Hono app (same shape as mcp.routes.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { createAuthStore } from '../src/db/authStore.js';
import { d1Adapter } from '../src/db/schema.js';
import { signupToken } from './helpers/passwordToken.js';

// Canonical RFC 7636 Appendix B PKCE pair.
const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const OWNER_PW = 'oauth-owner-password';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql', '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql', '0013_agent-token-label.sql', '0014_grant-family-link.sql',
  '0015_audit-log.sql', '0016_usage-counter.sql', '0017_oauth-provider.sql',
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

const makeEnv = (raw: Database.Database): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: 'deltos.oauth.routes', AUTH_PEPPER: 'oauth-routes-pepper' } as unknown as Env);

let raw: Database.Database;
let env: Env;
beforeEach(() => {
  raw = new Database(':memory:');
  for (const m of ALL_MIGRATIONS) raw.exec(m);
  env = makeEnv(raw);
});

const register = (body: unknown) =>
  app.request('/api/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, env);

describe('OAuth discovery documents', () => {
  it('serves RFC 8414 authorization-server metadata with the hard constraints', async () => {
    const res = await app.request('/.well-known/oauth-authorization-server', {}, env);
    expect(res.status).toBe(200);
    const md = await res.json();
    expect(md.registration_endpoint).toContain('/api/oauth/register');
    expect(md.authorization_endpoint).toContain('/api/oauth/authorize');
    expect(md.token_endpoint).toContain('/api/oauth/token');
    expect(md.code_challenge_methods_supported).toEqual(['S256']); // no 'plain'
    expect(md.grant_types_supported).toEqual(['authorization_code']);
    expect(md.token_endpoint_auth_methods_supported).toEqual(['none']); // public clients
  });

  it('serves RFC 9728 protected-resource metadata pointing at this AS + the mcp audience', async () => {
    const res = await app.request('/.well-known/oauth-protected-resource', {}, env);
    expect(res.status).toBe(200);
    const md = await res.json();
    expect(md.resource).toContain('/api/mcp');
    expect(Array.isArray(md.authorization_servers)).toBe(true);
    expect(md.scopes_supported).toEqual(['read', 'search']);
  });
});

describe('Dynamic Client Registration (RFC 7591)', () => {
  it('registers a public client for an https redirect and persists it', async () => {
    const res = await register({ redirect_uris: ['https://claude.ai/api/mcp/callback'], client_name: 'Claude' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBeTruthy();
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.grant_types).toEqual(['authorization_code']);
    expect(body).not.toHaveProperty('client_secret'); // public client — no secret ever

    const store = createAuthStore(d1Adapter(env.DB));
    const persisted = await store.getOauthClient(body.client_id);
    expect(persisted?.clientName).toBe('Claude');
    expect(persisted?.redirectUris).toEqual(['https://claude.ai/api/mcp/callback']);
  });

  it('registers a native client for a loopback redirect', async () => {
    const res = await register({ redirect_uris: ['http://127.0.0.1/callback'] });
    expect(res.status).toBe(201);
  });

  it('REFUSES a plaintext non-loopback redirect (code-leak guard)', async () => {
    const res = await register({ redirect_uris: ['http://evil.com/callback'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_redirect_uri');
  });

  it('rejects a registration with no redirect_uris', async () => {
    const res = await register({ client_name: 'no redirects' });
    expect(res.status).toBe(400);
  });
});

// Register a client and return its client_id + redirect.
async function registerClient(redirect = 'https://claude.ai/cb'): Promise<{ clientId: string; redirect: string }> {
  const res = await register({ redirect_uris: [redirect], client_name: 'Claude' });
  const body = await res.json();
  return { clientId: body.client_id, redirect };
}

// POST the consent-approval (bearer + step-up) — mirrors what the PWA consent screen sends.
const consent = (token: string, body: Record<string, unknown>) =>
  app.request('/api/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }, env);

// POST the token exchange, form-encoded (the OAuth default).
const tokenExchange = (params: Record<string, string>) =>
  app.request('/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  }, env);

const consentBody = (clientId: string, redirect: string, extra: Record<string, unknown> = {}) => ({
  client_id: clientId,
  redirect_uri: redirect,
  code_challenge: PKCE_CHALLENGE,
  code_challenge_method: 'S256',
  password: OWNER_PW,
  ...extra,
});

describe('authorize (consent) → token (PKCE) — the full flow', () => {
  it('mints a code on consent, exchanges it for a working read-only MCP token', async () => {
    const { token } = await signupToken(env, 'oauth-flow', OWNER_PW);
    const { clientId, redirect } = await registerClient();

    const cRes = await consent(token, consentBody(clientId, redirect, { state: 'xyz' }));
    expect(cRes.status).toBe(200);
    const { code, redirect_uri, state } = await cRes.json();
    expect(code).toBeTruthy();
    expect(redirect_uri).toBe(redirect);
    expect(state).toBe('xyz');

    const tRes = await tokenExchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: PKCE_VERIFIER,
    });
    expect(tRes.status).toBe(200);
    const tok = await tRes.json();
    expect(tok.token_type).toBe('Bearer');
    expect(tok.scope).toBe('read search');
    expect(tok).not.toHaveProperty('expires_in'); // non-expiring
    expect(tok).not.toHaveProperty('refresh_token');

    // The issued token authenticates to the MCP endpoint (inherits the agent path).
    const mcpRes = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${tok.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }, env);
    expect(mcpRes.status).toBe(200);
  });

  it('a code is SINGLE-USE — a replay is invalid_grant', async () => {
    const { token } = await signupToken(env, 'replay', OWNER_PW);
    const { clientId, redirect } = await registerClient();
    const { code } = await (await consent(token, consentBody(clientId, redirect))).json();
    const params = { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: PKCE_VERIFIER };

    expect((await tokenExchange(params)).status).toBe(200);
    const replay = await tokenExchange(params);
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe('invalid_grant');
  });

  it('a WRONG PKCE verifier is rejected (and burns the code)', async () => {
    const { token } = await signupToken(env, 'pkce', OWNER_PW);
    const { clientId, redirect } = await registerClient();
    const { code } = await (await consent(token, consentBody(clientId, redirect))).json();
    const bad = await tokenExchange({
      grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId,
      code_verifier: 'a-different-verifier-of-sufficient-length-4321',
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_grant');
  });

  it('consent to an UNREGISTERED redirect_uri is refused (no code minted)', async () => {
    const { token } = await signupToken(env, 'badredir', OWNER_PW);
    const { clientId } = await registerClient('https://claude.ai/cb');
    const res = await consent(token, consentBody(clientId, 'https://evil.com/cb'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });

  it('consent WITHOUT the step-up password is rejected', async () => {
    const { token } = await signupToken(env, 'nostepup', OWNER_PW);
    const { clientId, redirect } = await registerClient();
    const body = consentBody(clientId, redirect);
    delete (body as { password?: string }).password;
    const res = await consent(token, body);
    expect([401, 403, 400]).toContain(res.status); // step-up failure — no code
  });

  it('an AGENT token can NEVER self-consent (op share → 403)', async () => {
    const { token } = await signupToken(env, 'agent-consent', OWNER_PW);
    const { clientId, redirect } = await registerClient();
    // Mint a read-only agent token, then try to use IT as the bearer on /authorize.
    const minted = await (await app.request('/api/agent-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ password: OWNER_PW }),
    }, env)).json();
    const res = await consent(minted.token, consentBody(clientId, redirect));
    expect(res.status).toBe(403);
  });

  it('token exchange with a mismatched client_id is invalid_grant', async () => {
    const { token } = await signupToken(env, 'mismatch', OWNER_PW);
    const { clientId, redirect } = await registerClient();
    const other = await registerClient('https://claude.ai/other');
    const { code } = await (await consent(token, consentBody(clientId, redirect))).json();
    const res = await tokenExchange({
      grant_type: 'authorization_code', code, redirect_uri: redirect,
      client_id: other.clientId, code_verifier: PKCE_VERIFIER,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });
});

// Run the full connect flow; return the owner bearer, the issued access token, and the clientId.
async function connectApp(username: string): Promise<{ owner: string; accessToken: string; clientId: string }> {
  const { token: owner } = await signupToken(env, username, OWNER_PW);
  const { clientId, redirect } = await registerClient();
  const { code } = await (await consent(owner, consentBody(clientId, redirect))).json();
  const tok = await (await tokenExchange({
    grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: PKCE_VERIFIER,
  })).json();
  return { owner, accessToken: tok.access_token, clientId };
}

const mcpTools = (token: string) =>
  app.request('/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }, env);

describe('Connected apps — list / disconnect', () => {
  it('lists the connected app and does NOT surface it in the first-party agent-token list', async () => {
    const { owner, clientId } = await connectApp('connlist');
    const listed = await (await app.request('/api/oauth/clients', { headers: { Authorization: `Bearer ${owner}` } }, env)).json();
    expect(listed.apps).toHaveLength(1);
    expect(listed.apps[0].clientId).toBe(clientId);
    expect(listed.apps[0].scope).toEqual(['read', 'search']);

    // The OAuth grant must NOT appear among first-party agent tokens (disjoint surfaces).
    const agentList = await (await app.request('/api/agent-tokens', { headers: { Authorization: `Bearer ${owner}` } }, env)).json();
    expect(agentList.tokens).toHaveLength(0);
  });

  it('disconnect revokes the token IMMEDIATELY (next MCP call 401s)', async () => {
    const { owner, accessToken, clientId } = await connectApp('conndisc');
    expect((await mcpTools(accessToken)).status).toBe(200); // works before

    const del = await app.request(`/api/oauth/clients/${clientId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${owner}` } }, env);
    expect(del.status).toBe(200);
    expect((await mcpTools(accessToken)).status).toBe(401); // dead after
  });

  it('BOLA: account B cannot disconnect account A’s app', async () => {
    const { clientId } = await connectApp('ownerA');
    const { token: bTok } = await signupToken(env, 'ownerB', OWNER_PW);
    const del = await app.request(`/api/oauth/clients/${clientId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${bTok}` } }, env);
    expect(del.status).toBe(404); // not-yours == not-found (no existence disclosure)
  });

  it('an agent token cannot list connected apps (op share → 403)', async () => {
    const { token } = await signupToken(env, 'agent-list', OWNER_PW);
    const minted = await (await app.request('/api/agent-tokens', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ password: OWNER_PW }),
    }, env)).json();
    const res = await app.request('/api/oauth/clients', { headers: { Authorization: `Bearer ${minted.token}` } }, env);
    expect(res.status).toBe(403);
  });
});

describe('client retention prune (pruneOauthClients)', () => {
  it('drops a stale client with no live grant, keeps a stale client WITH a live grant + any recent client', async () => {
    const store = createAuthStore(d1Adapter(env.DB));
    const DAY = 86_400_000;
    const oldIso = new Date(Date.now() - 60 * DAY).toISOString();
    const nowIso = new Date().toISOString();
    const base = { clientName: 'x', redirectUris: ['https://a/cb'], softwareId: null, metadata: null };

    await store.registerOauthClient({ clientId: 'stale-nogrant', ...base, createdAt: oldIso });
    await store.registerOauthClient({ clientId: 'stale-live', ...base, createdAt: oldIso });
    await store.registerOauthClient({ clientId: 'recent-nogrant', ...base, createdAt: nowIso });
    // stale-live holds a live OAuth grant → must be kept regardless of age.
    await store.insertAgentGrant({
      grantId: 'g-live', tokenHash: 'h-live', accountId: 'acct-1', label: 'x',
      resource: { kind: 'workspace' }, scope: ['read', 'search'], createdAt: oldIso, clientId: 'stale-live',
    });

    await store.pruneOauthClients(new Date(Date.now() - 30 * DAY).toISOString());

    expect(await store.getOauthClient('stale-nogrant')).toBeNull(); // reaped
    expect(await store.getOauthClient('stale-live')).not.toBeNull(); // kept (live grant)
    expect(await store.getOauthClient('recent-nogrant')).not.toBeNull(); // kept (recent)
  });
});

describe('MCP 401 → discovery pointer', () => {
  it('a tokenless /api/mcp 401 carries the RFC 9728 resource_metadata pointer', async () => {
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }, env);
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('WWW-Authenticate') ?? '';
    expect(wwwAuth).toContain('resource_metadata=');
    expect(wwwAuth).toContain('/.well-known/oauth-protected-resource');
  });
});
