/**
 * Route + chokepoint tests for the Active-sessions surface (Phase 2 — sessions management):
 * GET /api/auth/sessions, DELETE /api/auth/sessions/:familyId, POST /api/auth/sessions/signout-others.
 * This is externally-reachable CREDENTIAL-lifecycle machinery, so the bar is the security contract, not
 * just the happy path:
 *   - list returns the account's ACTIVE sessions, marks `current` correctly, and is account-scoped
 *     (account B sees none of A's);
 *   - a second login = a second session; DELETE :familyId drops it AND revokes its linked access grant;
 *   - 🚨 BOLA: account B cannot revoke account A's session (404, A's session survives);
 *   - signout-others revokes the OTHERS but NOT the current family, and does NOT touch agent tokens;
 *   - deviceLabelFromUA maps a few UA strings to the expected coarse labels.
 *
 * Self-contained harness: better-sqlite3 → D1 shim + the real Hono app + the shared signup helper, with a
 * `loginSession` helper that drives signup → recovery/rotate → finalize → login so a durable refresh
 * SESSION (the thing this surface lists) actually exists. ALL migrations incl. 0014 are loaded.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { deviceLabelFromUA } from '../src/deviceLabel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql',
  '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql',
  '0013_agent-token-label.sql',
  '0014_grant-family-link.sql',
  '0015_audit-log.sql',
  '0016_usage-counter.sql',
  '0017_oauth-provider.sql',
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

const AUD = 'deltos.sessions.routes';
// Lets the loginSession helper reach the raw better-sqlite3 handle behind an Env (to clear the ceremony's
// refresh row), without threading it through every call.
const rawByEnv = new WeakMap<Env, Database.Database>();
const makeEnv = (raw: Database.Database): Env => {
  const env = { DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, AUTH_PEPPER: 'sessions-pepper' } as unknown as Env;
  rawByEnv.set(env, raw);
  return env;
};

const json = { 'content-type': 'application/json' };
const post = (env: Env, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) }, env);
const authed = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Extract the refresh cookie value from a Set-Cookie header so the next request can present it. */
function refreshCookie(res: Response): string | null {
  const sc = res.headers.get('set-cookie');
  if (!sc) return null;
  const m = /(?:^|,\s*)(deltos_refresh=[^;]+)/.exec(sc);
  return m?.[1] ?? null;
}

interface LoggedIn {
  token: string;      // a session-backed access bearer (its grant carries the login family)
  accountId: string;
  username: string;
  password: string;
  cookie: string;     // the durable refresh cookie for this login (for rotation tests)
}

/**
 * Stand up a FINALIZED account (signup → recovery/rotate → finalize) then LOGIN to mint a durable refresh
 * session. Returns a session-backed access bearer + the refresh cookie. A second call of `login()` on the
 * returned handle mints a SECOND, distinct session (a second device).
 */
async function loginSession(env: Env, username: string, password = 'correct-horse-battery-staple'): Promise<{
  handle: LoggedIn;
  login: () => Promise<LoggedIn>;
}> {
  const signup = await post(env, '/api/auth/signup', { username, password });
  if (signup.status !== 201) throw new Error(`signup failed: ${signup.status} ${await signup.text()}`);
  const { token: signupToken, accountId } = (await signup.json()) as { token: string; accountId: string };

  // Establish recovery + finalize (sets recoveryEstablished=true so a subsequent login issues a refresh).
  const rot = await post(env, '/api/auth/recovery/rotate', {}, authed(signupToken));
  if (rot.status !== 200) throw new Error(`rotate failed: ${rot.status} ${await rot.text()}`);
  const fin = await post(env, '/api/auth/finalize', {}, { ...authed(signupToken), Origin: `https://${AUD}` });
  if (fin.status !== 200) throw new Error(`finalize failed: ${fin.status} ${await fin.text()}`);

  // /finalize ALSO inserts a durable refresh session (the SUSPENDERS row). For these tests we want LOGIN
  // to be the sole, deterministic source of sessions for the account, so clear the ceremony's refresh row
  // here — leaving exactly the sessions we then create via login(). (Test scaffolding only; not a contract.)
  rawByEnv.get(env)!.prepare('DELETE FROM refreshSessions WHERE accountId = ?').run(accountId);

  const login = async (): Promise<LoggedIn> => {
    const res = await post(env, '/api/auth/login', { username, password }, { 'user-agent': 'test-agent' });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { token: string; accountId: string; username: string };
    return { token: body.token, accountId: body.accountId, username: body.username, password, cookie: refreshCookie(res) ?? '' };
  };

  const handle = await login();
  return { handle, login };
}

const get = (env: Env, path: string, token: string) => app.request(path, { headers: authed(token) }, env);
const del = (env: Env, path: string, token: string) =>
  app.request(path, { method: 'DELETE', headers: authed(token) }, env);

interface SessionRow { familyId: string; label: string | null; createdAt: string; current: boolean }
const listSessions = async (env: Env, token: string): Promise<SessionRow[]> =>
  ((await (await get(env, '/api/auth/sessions', token)).json()) as { sessions: SessionRow[] }).sessions;

describe('active sessions — list / revoke-one / signout-others (route + chokepoint)', () => {
  let env: Env;
  let raw: Database.Database;

  beforeEach(() => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
  });

  it('list returns the account active sessions, marks `current`, and is account-scoped', async () => {
    const { handle: a } = await loginSession(env, 'alice');
    const { handle: b } = await loginSession(env, 'bob');

    const aSessions = await listSessions(env, a.token);
    expect(aSessions).toHaveLength(1);
    expect(aSessions[0].current).toBe(true); // the bearer's own session is marked current
    expect(aSessions[0].label).toBe('Unknown device'); // 'test-agent' UA → recognized as a present-but-unknown UA

    // Account B sees ONLY its own session — none of A's.
    const bSessions = await listSessions(env, b.token);
    expect(bSessions).toHaveLength(1);
    expect(bSessions[0].familyId).not.toBe(aSessions[0].familyId);
  });

  it('a second login = a second session; DELETE :familyId drops it AND revokes its linked access grant', async () => {
    const { handle: a, login } = await loginSession(env, 'carol');
    const second = await login(); // a second device/session for the SAME account

    let sessions = await listSessions(env, a.token);
    expect(sessions).toHaveLength(2);

    // From the FIRST session, identify + revoke the SECOND (the non-current) one.
    const sortByCurrent = sessions.find((s) => !s.current)!;
    const targetFamily = sortByCurrent.familyId;

    // The second session's access grant exists + is live before revoke.
    const grantBefore = raw
      .prepare("SELECT revokedAt FROM grants WHERE familyId = ? AND principalKind = 'owner'")
      .get(targetFamily) as { revokedAt: string | null } | undefined;
    expect(grantBefore?.revokedAt ?? null).toBeNull();

    const res = await del(env, `/api/auth/sessions/${targetFamily}`, a.token);
    expect(res.status).toBe(200);
    expect((await res.json()) as { revoked: boolean }).toMatchObject({ revoked: true });

    // The refresh family is revoked AND the linked access grant is revoked (immediate access kill).
    const refreshRow = raw.prepare('SELECT revokedAt FROM refreshSessions WHERE familyId = ?').get(targetFamily) as { revokedAt: string | null };
    expect(refreshRow.revokedAt).not.toBeNull();
    const grantAfter = raw
      .prepare("SELECT revokedAt FROM grants WHERE familyId = ? AND principalKind = 'owner'")
      .get(targetFamily) as { revokedAt: string | null };
    expect(grantAfter.revokedAt).not.toBeNull();

    // The active list now shows only the surviving (current) session.
    sessions = await listSessions(env, a.token);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].current).toBe(true);

    // Mark `second` unused for the linter while documenting intent.
    expect(second.token).toBeTypeOf('string');
  });

  it('🚨 BOLA: account B cannot revoke account A session (404, A session survives)', async () => {
    const { handle: a } = await loginSession(env, 'dave');
    const { handle: b } = await loginSession(env, 'eve');

    const aFamily = (await listSessions(env, a.token))[0].familyId;

    // B tries to revoke A's session — 404 (not 403: no cross-account existence disclosure).
    const res = await del(env, `/api/auth/sessions/${aFamily}`, b.token);
    expect(res.status).toBe(404);

    // A's session is UNTOUCHED — still active, refresh + grant unrevoked.
    const refreshRow = raw.prepare('SELECT revokedAt FROM refreshSessions WHERE familyId = ?').get(aFamily) as { revokedAt: string | null };
    expect(refreshRow.revokedAt).toBeNull();
    expect(await listSessions(env, a.token)).toHaveLength(1);
  });

  it('revoking an unknown familyId is 404', async () => {
    const { handle: a } = await loginSession(env, 'frank');
    const res = await del(env, '/api/auth/sessions/does-not-exist', a.token);
    expect(res.status).toBe(404);
  });

  it('signout-others revokes the OTHERS but not the current family, and does NOT touch agent tokens', async () => {
    const { handle: a, login } = await loginSession(env, 'grace');
    await login(); // session 2
    await login(); // session 3
    expect(await listSessions(env, a.token)).toHaveLength(3);

    // Mint an agent token (NULL familyId) — it MUST survive signout-others.
    const minted = (await (await post(env, '/api/agent-tokens', { label: 'Claude', password: a.password }, authed(a.token))).json()) as { grantId: string }; // H1: mint needs step-up password
    const currentFamily = (await listSessions(env, a.token)).find((s) => s.current)!.familyId;

    const res = await post(env, '/api/auth/sessions/signout-others', {}, authed(a.token));
    expect(res.status).toBe(200);
    expect((await res.json()) as { revoked: number }).toMatchObject({ revoked: 2 }); // 2 OTHER refresh families

    // Only the current session survives.
    const after = await listSessions(env, a.token);
    expect(after).toHaveLength(1);
    expect(after[0].familyId).toBe(currentFamily);

    // The current session's refresh + access grant are untouched.
    const currentRefresh = raw.prepare('SELECT COUNT(*) AS n FROM refreshSessions WHERE familyId = ? AND revokedAt IS NULL').get(currentFamily) as { n: number };
    expect(currentRefresh.n).toBeGreaterThan(0);
    const currentGrant = raw.prepare("SELECT COUNT(*) AS n FROM grants WHERE familyId = ? AND principalKind = 'owner' AND revokedAt IS NULL").get(currentFamily) as { n: number };
    expect(currentGrant.n).toBeGreaterThan(0);

    // The AGENT token (NULL familyId) is STILL live — signout-others never reaches it.
    const agentRow = raw.prepare('SELECT revokedAt, familyId FROM grants WHERE grantId = ?').get(minted.grantId) as { revokedAt: string | null; familyId: string | null };
    expect(agentRow.revokedAt).toBeNull();
    expect(agentRow.familyId).toBeNull();
  });

  it('an agent token can NEVER list or revoke sessions (op share → 403)', async () => {
    const { handle: a } = await loginSession(env, 'heidi');
    const aFamily = (await listSessions(env, a.token))[0].familyId;
    const agent = (await (await post(env, '/api/agent-tokens', { password: a.password }, authed(a.token))).json()) as { token: string }; // H1: mint needs step-up password

    expect((await get(env, '/api/auth/sessions', agent.token)).status).toBe(403);
    expect((await del(env, `/api/auth/sessions/${aFamily}`, agent.token)).status).toBe(403);
    expect((await post(env, '/api/auth/sessions/signout-others', {}, authed(agent.token))).status).toBe(403);

    // A's session is untouched by the failed agent attempts.
    expect(await listSessions(env, a.token)).toHaveLength(1);
  });
});

describe('deviceLabelFromUA', () => {
  it('maps coarse UA strings to "<Browser> on <Platform>" labels', () => {
    expect(
      deviceLabelFromUA(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iPhone');
    expect(
      deviceLabelFromUA(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS');
    expect(
      deviceLabelFromUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'),
    ).toBe('Firefox on Windows');
    expect(
      deviceLabelFromUA(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      ),
    ).toBe('Edge on Windows'); // Edge precedes Chrome despite embedding "Chrome"
    expect(deviceLabelFromUA(undefined)).toBeNull();
    expect(deviceLabelFromUA('')).toBeNull();
    expect(deviceLabelFromUA('some-opaque-non-browser-agent/1.0')).toBe('Unknown device');
  });
});
