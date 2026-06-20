import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { createAuthStore } from '../src/db/authStore.js';
import { d1Adapter } from '../src/db/schema.js';
import { codeAtStep, stepAt, base32ToBytes } from '../src/totp.js';

/**
 * Password-auth route tests — AP-T1..T10 of the acceptance matrix
 * (`docs/specs/auth-pivot-acceptance-matrix.md`). The protocol-correctness half: anti-enumeration
 * responses, gate-before-hash ordering, refresh rotation + reuse-detection + revoke-all on the four
 * credential-change events, TOTP confirm-before-activate + replay guard, the phrase verifier, and
 * no-bearer-at-rest (the cookie carries the durable credential). Runs against the real Argon2id (target
 * params) so the cost is honest; a generous per-test timeout absorbs it.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const T = 30_000; // Argon2id at target params is ~325ms/hash — keep timeouts generous.

const migrations = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0003_account-identity.sql',
  '0004_password-auth.sql',
  '0005_recovery-established.sql',
  '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql',
  '0008_notebooks.sql',
  '0009_backfill-default-notebooks.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      sql,
      _params: [] as unknown[],
      bind(...p: unknown[]) {
        stmt._params = p;
        return stmt;
      },
      async first<T2>() {
        return (raw.prepare(sql).get(...(stmt._params as never[])) ?? null) as T2 | null;
      },
      async all<T2>() {
        return { results: raw.prepare(sql).all(...(stmt._params as never[])) as T2[] };
      },
      async run() {
        const info = raw.prepare(sql).run(...(stmt._params as never[]));
        return { meta: { rows_written: info.changes } };
      },
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

function freshDb(): Database.Database {
  const raw = new Database(':memory:');
  for (const m of migrations) raw.exec(m);
  return raw;
}

const makeEnv = (raw: Database.Database, over: Partial<Env> = {}): Env =>
  ({
    DB: d1Over(raw),
    ENVIRONMENT: 'development',
    AUTH_AUDIENCE: 'deltos.test',
    AUTH_PEPPER: 'unit-test-pepper',
    TOTP_ENC_KEY: 'unit-test-totp-key',
    ...over,
  }) as unknown as Env;

const post = (env: Env, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? '{}' : JSON.stringify(body),
    },
    env,
  );

/** Pull the refresh-cookie token value out of a Set-Cookie header (undici exposes getSetCookie). */
function setCookieHeaders(res: Response): string[] {
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie();
  const one = res.headers.get('set-cookie');
  return one ? [one] : [];
}
function refreshCookieValue(res: Response): string | null {
  for (const sc of setCookieHeaders(res)) {
    const m = /^deltos_rt=([^;]*)/.exec(sc);
    if (m && m[1] && m[1].length > 0) return m[1];
  }
  return null;
}
const cookieHeader = (value: string) => ({ Cookie: `deltos_rt=${value}` });

interface SignupResult {
  accountId: string;
  username: string;
  token: string;
  expiresAt: string;
  /** Set only by the full happy-path `signup()` (sourced from /recovery/rotate); absent for the raw path. */
  recoveryPhrase?: string;
}

/**
 * The full happy-path registration (Option B): signup → /recovery/rotate (establish + return the phrase)
 * → /finalize (establish recovery + durable cookie). Returns the rotate-minted recovery phrase so reset
 * tests can use it. Subsequent logins then behave normally (cookie + recoveryEstablished=true).
 */
async function signup(env: Env, username: string, password: string): Promise<Required<SignupResult>> {
  const res = await post(env, '/api/auth/signup', { username, password });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = (await res.json()) as SignupResult;
  const rot = await post(env, '/api/auth/recovery/rotate', {}, { Authorization: `Bearer ${body.token}` });
  expect(rot.status, await rot.clone().text()).toBe(200);
  const { recoveryPhrase } = (await rot.json()) as { recoveryPhrase: string };
  const fin = await post(env, '/api/auth/finalize', {}, { Authorization: `Bearer ${body.token}` });
  expect(fin.status, await fin.clone().text()).toBe(200);
  return { ...body, recoveryPhrase };
}

/** Sign up WITHOUT rotate/finalize — the abandoned-registration path (recovery never established). */
async function signupNoFinalize(env: Env, username: string, password: string): Promise<SignupResult> {
  const res = await post(env, '/api/auth/signup', { username, password });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as SignupResult;
}

// Clone before reading so the body stays consumable by a later .json()/.text() on the original.
const bodyText = async (res: Response) => `${res.status} ${await res.clone().text()}`;

// ===========================================================================
// AP-T1 — register on the D6 spine + atomic claim + session + refresh cookie + phrase once; taken→taken
// ===========================================================================
describe('AP-T1 — POST /signup', () => {
  it(
    'creates an account + access token, but NO recovery phrase (single-hash, Option B) and NO durable cookie (P0 suspenders)',
    async () => {
      const env = makeEnv(freshDb());
      const res = await post(env, '/api/auth/signup', { username: 'Alice', password: 'correct-horse' });
      expect(res.status, await bodyText(res)).toBe(201);
      const body = (await res.json()) as SignupResult & { recoveryPhrase?: string };
      expect(body.accountId).toMatch(/.+/);
      expect(body.username).toBe('Alice'); // display form preserved
      expect(body.token).toMatch(/.+/);
      // Option B: signup is a SINGLE Argon2id (password only) — no recovery phrase here (it comes from /recovery/rotate).
      expect(body.recoveryPhrase).toBeUndefined();
      // P0 SUSPENDERS: signup must NOT set the durable refresh cookie (cross-boot durability waits for finalize).
      expect(refreshCookieValue(res)).toBeNull();
    },
    T,
  );

  it(
    'FINALIZE is REFUSED until recovery is established (belt guard), then sets recoveryEstablished + the durable cookie',
    async () => {
      const raw = freshDb();
      // Use production mode so the cookie-format assertions reflect the real production shape
      // (Secure is only set in non-dev environments — see setRefreshCookie).
      const env = makeEnv(raw, { ENVIRONMENT: 'production' });
      const signupRes = await post(env, '/api/auth/signup', { username: 'finalizer', password: 'finalize-pass-1' });
      const body = (await signupRes.json()) as SignupResult;
      const flag = () =>
        (raw.prepare('SELECT recoveryEstablished FROM passwordCredentials WHERE accountId=?').get(body.accountId) as {
          recoveryEstablished: number;
        }).recoveryEstablished;
      expect(flag()).toBe(0);

      // BELT GUARD: finalize before establishing recovery (no /recovery/rotate) is refused — no silent
      // "established" account with no recoverable phrase.
      const early = await post(env, '/api/auth/finalize', {}, { Authorization: `Bearer ${body.token}` });
      expect(early.status).toBe(409);
      expect(((await early.json()) as { error: { code: string } }).error.code).toBe('recovery_not_established');
      expect(flag()).toBe(0);
      expect(refreshCookieValue(early)).toBeNull();

      // Establish recovery (rotate), THEN finalize succeeds.
      const rot = await post(env, '/api/auth/recovery/rotate', {}, { Authorization: `Bearer ${body.token}` });
      expect(rot.status, await bodyText(rot)).toBe(200);
      const fin = await post(env, '/api/auth/finalize', {}, { Authorization: `Bearer ${body.token}` });
      expect(fin.status, await bodyText(fin)).toBe(200);
      const sc = setCookieHeaders(fin).find((s) => s.startsWith('deltos_rt='));
      expect(sc).toBeDefined();
      expect(sc).toMatch(/HttpOnly/i);
      expect(sc).toMatch(/Secure/i);
      expect(sc).toMatch(/SameSite=Strict/i);
      expect(sc).toMatch(/Path=\/api\/auth\/refresh/i);
      expect(flag()).toBe(1);
    },
    T,
  );

  it(
    'DISCLOSES "username taken" (AP-1d) and leaves NO orphan account (secSys hygiene)',
    async () => {
      const raw = freshDb();
      const env = makeEnv(raw);
      await signup(env, 'bob', 'password-one');
      const res = await post(env, '/api/auth/signup', { username: 'BOB', password: 'password-two' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('username_taken');
      // The failed (taken) signup must not leave an orphan account — only bob's account exists.
      expect((raw.prepare('SELECT COUNT(*) as n FROM accounts').get() as { n: number }).n).toBe(1);
    },
    T,
  );

  it('fails closed (503) when AUTH_PEPPER is unconfigured', async () => {
    const env = makeEnv(freshDb(), { AUTH_PEPPER: undefined });
    const res = await post(env, '/api/auth/signup', { username: 'carol', password: 'password-xyz' });
    expect(res.status).toBe(503);
  });
});

// ===========================================================================
// AP-T2 — login: unknown-user / wrong-password / bad-TOTP → byte-identical 401; success → session+cookie
// ===========================================================================
describe('AP-T2 — POST /login uniform error', () => {
  it(
    'unknown-user and wrong-password return a BYTE-IDENTICAL 401 (no enumeration)',
    async () => {
      const env = makeEnv(freshDb());
      await signup(env, 'dave', 'the-real-password');
      const unknown = await post(env, '/api/auth/login', { username: 'nobody', password: 'whatever-1' });
      const wrongPw = await post(env, '/api/auth/login', { username: 'dave', password: 'wrong-pass-1' });
      expect(unknown.status).toBe(401);
      expect(wrongPw.status).toBe(401);
      expect(await unknown.text()).toBe(await wrongPw.text());
    },
    T,
  );

  it(
    'a correct login returns an access token + accountId + username + refresh cookie',
    async () => {
      const env = makeEnv(freshDb());
      const acct = await signup(env, 'erin', 'erin-password-9');
      const res = await post(env, '/api/auth/login', { username: 'erin', password: 'erin-password-9' });
      expect(res.status, await bodyText(res)).toBe(200);
      const body = (await res.json()) as { token: string; accountId: string; username: string };
      expect(body.token).toMatch(/.+/);
      expect(body.accountId).toBe(acct.accountId);
      expect(body.username).toBe('erin');
      expect(refreshCookieValue(res)).toBeTruthy();
    },
    T,
  );
});

// ===========================================================================
// AP-T3 — reset is NON-DISCLOSING: unknown-username and wrong-phrase return the identical response
// ===========================================================================
describe('AP-T3 — POST /reset non-disclosing', () => {
  it(
    'unknown-username and known-username-wrong-phrase return an identical response',
    async () => {
      const env = makeEnv(freshDb());
      await signup(env, 'frank', 'frank-password-1');
      const unknown = await post(env, '/api/auth/reset', {
        username: 'ghost',
        recoveryPhrase: 'aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh',
        newPassword: 'brand-new-pass-1',
      });
      const wrongPhrase = await post(env, '/api/auth/reset', {
        username: 'frank',
        recoveryPhrase: 'aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh',
        newPassword: 'brand-new-pass-1',
      });
      expect(unknown.status).toBe(401);
      expect(wrongPhrase.status).toBe(401);
      expect(await unknown.text()).toBe(await wrongPhrase.text());
    },
    T,
  );
});

// ===========================================================================
// AP-T4 — gate BEFORE Argon2id: a throttled request is rejected WITHOUT reaching the hash
// ===========================================================================
describe('AP-T4 — gate-before-hash', () => {
  it(
    'a throttled login returns 429 without hashing (failures count does NOT advance; returns fast)',
    async () => {
      const raw = freshDb();
      const env = makeEnv(raw);
      await signup(env, 'gwen', 'gwen-password-1');
      const store = createAuthStore(d1Adapter(d1Over(raw)));
      // Seed the bucket as already-throttled far into the future.
      await store.recordThrottleFailure('login:gwen', 10, Date.now() + 10 * 60_000, new Date().toISOString());

      const started = Date.now();
      const res = await post(env, '/api/auth/login', { username: 'gwen', password: 'gwen-password-1' });
      const elapsed = Date.now() - started;

      expect(res.status).toBe(429);
      // Gate returned BEFORE recordFailure → the count is unchanged (a hashed-then-failed path bumps it).
      expect((await store.getThrottle('login:gwen'))?.failures).toBe(10);
      // And it returned fast — no ~325ms Argon2id ran (loose bound; pure D1 reads are well under this).
      expect(elapsed).toBeLessThan(150);
    },
    T,
  );
});

// ===========================================================================
// AP-T5 — uniform real-or-DUMMY hash: unknown-user still does Argon2id work (no timing oracle, no early return)
// ===========================================================================
describe('AP-T5 — uniform dummy hash on unknown user', () => {
  it(
    'an unknown-user login is NOT short-circuited (it pays the Argon2id cost)',
    async () => {
      const env = makeEnv(freshDb());
      const started = Date.now();
      const res = await post(env, '/api/auth/login', { username: 'no-such-user', password: 'whatever-12' });
      const elapsed = Date.now() - started;
      expect(res.status).toBe(401);
      // A real Argon2id hash at target params dominates; an early return would be near-instant.
      expect(elapsed).toBeGreaterThan(50);
    },
    T,
  );
});

// ===========================================================================
// AP-T7 — refresh: stored as a hash (≠ raw); rotation-on-use; replay of a rotated token → family revoked;
//          CSRF origin belt
// ===========================================================================
describe('AP-T7 — refresh rotation + reuse-detection + CSRF', () => {
  it(
    'rotates on use (new cookie, fresh access token) and never stores the raw token',
    async () => {
      const raw = freshDb();
      const env = makeEnv(raw);
      const acct = await signup(env, 'hugo', 'hugo-password-1');
      const login = await post(env, '/api/auth/login', { username: 'hugo', password: 'hugo-password-1' });
      const rt1 = refreshCookieValue(login)!;
      expect(rt1).toBeTruthy();

      // Only the HASH is stored — the raw token is not a row key.
      const stored = raw.prepare('SELECT tokenHash FROM refreshSessions').all() as Array<{ tokenHash: string }>;
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.some((r) => r.tokenHash === rt1)).toBe(false);

      const refreshed = await post(env, '/api/auth/refresh', undefined, cookieHeader(rt1));
      expect(refreshed.status, await bodyText(refreshed)).toBe(200);
      const body = (await refreshed.json()) as { token: string; accountId: string };
      expect(body.accountId).toBe(acct.accountId);
      const rt2 = refreshCookieValue(refreshed)!;
      expect(rt2).toBeTruthy();
      expect(rt2).not.toBe(rt1); // rotated
    },
    T,
  );

  it(
    'REUSE DETECTION: replaying an already-rotated token revokes the whole family',
    async () => {
      const env = makeEnv(freshDb());
      await signup(env, 'iris', 'iris-password-1');
      const login = await post(env, '/api/auth/login', { username: 'iris', password: 'iris-password-1' });
      const rt1 = refreshCookieValue(login)!;
      const refreshed = await post(env, '/api/auth/refresh', undefined, cookieHeader(rt1));
      const rt2 = refreshCookieValue(refreshed)!;

      // Replay the SPENT token rt1 → theft signal → 401 + family revoked.
      const replay = await post(env, '/api/auth/refresh', undefined, cookieHeader(rt1));
      expect(replay.status).toBe(401);
      // rt2 (the legitimate successor) is now also dead — the whole family was revoked.
      const afterRevoke = await post(env, '/api/auth/refresh', undefined, cookieHeader(rt2));
      expect(afterRevoke.status).toBe(401);
    },
    T,
  );

  it(
    'CSRF belt: a cross-origin refresh is rejected (403)',
    async () => {
      const env = makeEnv(freshDb());
      await signup(env, 'jack', 'jack-password-1');
      const login = await post(env, '/api/auth/login', { username: 'jack', password: 'jack-password-1' });
      const rt1 = refreshCookieValue(login)!;
      const res = await post(env, '/api/auth/refresh', undefined, {
        ...cookieHeader(rt1),
        Origin: 'https://evil.example.com',
      });
      expect(res.status).toBe(403);
    },
    T,
  );

  it(
    'CSRF belt (#40): in prod a same-host http:// Origin is rejected, https accepted; relaxed in dev',
    async () => {
      const env = makeEnv(freshDb(), { ENVIRONMENT: 'production' });
      await signup(env, 'liam', 'liam-password-1');
      const login = await post(env, '/api/auth/login', { username: 'liam', password: 'liam-password-1' });
      const rt1 = refreshCookieValue(login)!;
      // Same host (matches AUTH_AUDIENCE) but DOWNGRADED scheme → rejected in prod. The Origin belt
      // runs before the cookie is consumed, so rt1 survives for the positive assertion below.
      const downgraded = await post(env, '/api/auth/refresh', undefined, {
        ...cookieHeader(rt1),
        Origin: 'http://deltos.test',
      });
      expect(downgraded.status, await bodyText(downgraded)).toBe(403);
      // https same-host Origin still passes.
      const ok = await post(env, '/api/auth/refresh', undefined, {
        ...cookieHeader(rt1),
        Origin: 'https://deltos.test',
      });
      expect(ok.status, await bodyText(ok)).toBe(200);

      // In a named non-prod environment the scheme pin is relaxed so local http dev servers work.
      const devEnv = makeEnv(freshDb()); // ENVIRONMENT: 'development'
      await signup(devEnv, 'liam', 'liam-password-1');
      const devLogin = await post(devEnv, '/api/auth/login', { username: 'liam', password: 'liam-password-1' });
      const devRt = refreshCookieValue(devLogin)!;
      const devHttp = await post(devEnv, '/api/auth/refresh', undefined, {
        ...cookieHeader(devRt),
        Origin: 'http://deltos.test',
      });
      expect(devHttp.status, await bodyText(devHttp)).toBe(200);
    },
    T,
  );
});

// ===========================================================================
// AP-T8 — revoke-all on the four credential-change events (reset / password-change / logout / 2FA-change)
// ===========================================================================
describe('AP-T8 — revoke-all', () => {
  it('store primitive revokes EVERY non-revoked family for the account', async () => {
    const raw = freshDb();
    const store = createAuthStore(d1Adapter(d1Over(raw)));
    const now = Date.now();
    for (const fam of ['f1', 'f2', 'f3']) {
      await store.insertRefreshSession({
        tokenHash: `h-${fam}`,
        familyId: fam,
        accountId: 'acct-1',
        issuedAtMs: now,
        expiresAtMs: now + 1_000_000,
      });
    }
    const affected = await store.revokeAllRefreshForAccount('acct-1', new Date(now).toISOString());
    expect(affected).toBe(3);
  });

  it(
    'LOGOUT revokes all refresh families (the cookie no longer refreshes)',
    async () => {
      const env = makeEnv(freshDb());
      const acct = await signup(env, 'kate', 'kate-password-1');
      const login = await post(env, '/api/auth/login', { username: 'kate', password: 'kate-password-1' });
      const rt = refreshCookieValue(login)!;
      const out = await post(env, '/api/auth/logout', {}, { Authorization: `Bearer ${acct.token}` });
      expect(out.status).toBe(200);
      const afterLogout = await post(env, '/api/auth/refresh', undefined, cookieHeader(rt));
      expect(afterLogout.status).toBe(401);
    },
    T,
  );

  it(
    'RESET (password-change) revokes all sessions + clears the throttle and lets the new password log in',
    async () => {
      const env = makeEnv(freshDb());
      const acct = await signup(env, 'liam', 'liam-old-password');
      const login = await post(env, '/api/auth/login', { username: 'liam', password: 'liam-old-password' });
      const rt = refreshCookieValue(login)!;
      const reset = await post(env, '/api/auth/reset', {
        username: 'liam',
        recoveryPhrase: acct.recoveryPhrase,
        newPassword: 'liam-new-password',
      });
      expect(reset.status, await bodyText(reset)).toBe(200);
      // Old refresh family is dead.
      expect((await post(env, '/api/auth/refresh', undefined, cookieHeader(rt))).status).toBe(401);
      // Old password no longer works; the new one does.
      expect((await post(env, '/api/auth/login', { username: 'liam', password: 'liam-old-password' })).status).toBe(401);
      expect((await post(env, '/api/auth/login', { username: 'liam', password: 'liam-new-password' })).status).toBe(200);
    },
    T,
  );

  it(
    '2FA-CHANGE (enable via /totp/verify) revokes OTHER sessions but RE-ISSUES the acting device (#41)',
    async () => {
      const env = makeEnv(freshDb());
      const acct = await signup(env, 'tfa-on', 'tfa-on-pass-1'); // signup() finalizes the acting device

      // A second device logs in → its own live refresh family. Capture its cookie to prove it dies.
      const other = await post(env, '/api/auth/login', { username: 'tfa-on', password: 'tfa-on-pass-1' });
      const otherCookie = refreshCookieValue(other)!;

      // Enable 2FA (confirm-before-activate) — a credential change → revoke-all THEN re-issue this device.
      const setup = await post(env, '/api/auth/totp/setup', {}, { Authorization: `Bearer ${acct.token}` });
      const { secret } = (await setup.json()) as { secret: string };
      const verify = await post(
        env,
        '/api/auth/totp/verify',
        { code: codeAtStep(base32ToBytes(secret), stepAt(Date.now())) },
        { Authorization: `Bearer ${acct.token}` },
      );
      expect(verify.status, await bodyText(verify)).toBe(200);

      // Acting device STAYS signed in: a fresh access token + a fresh, working refresh cookie come back.
      const vbody = (await verify.json()) as { enabled: boolean; token: string; expiresAt: string };
      expect(vbody.enabled).toBe(true);
      expect(vbody.token).toMatch(/.+/);
      const freshCookie = refreshCookieValue(verify)!;
      expect(freshCookie).toBeTruthy();
      expect((await post(env, '/api/auth/refresh', {}, cookieHeader(freshCookie))).status).toBe(200);

      // The OTHER device's session is revoked — its cookie no longer refreshes.
      expect((await post(env, '/api/auth/refresh', {}, cookieHeader(otherCookie))).status).toBe(401);
    },
    T,
  );

  it(
    '2FA-CHANGE (disable via /totp/disable) revokes OTHER sessions but RE-ISSUES the acting device (#41)',
    async () => {
      const env = makeEnv(freshDb());
      const acct = await signup(env, 'tfa-off', 'tfa-off-pass-1');

      const { secret } = (await (
        await post(env, '/api/auth/totp/setup', {}, { Authorization: `Bearer ${acct.token}` })
      ).json()) as { secret: string };
      const secretBytes = base32ToBytes(secret);
      const step = stepAt(Date.now());
      // Only step-1 / step / step+1 are inside the ±1 skew window, so spend them across the 3 codes:
      // enable (step-1) → other-device login (step) → disable (step+1).
      // Enable on step-1; the enable response re-issues the ACTING device's session (token + cookie).
      const enable = await post(env, '/api/auth/totp/verify', { code: codeAtStep(secretBytes, step - 1) }, { Authorization: `Bearer ${acct.token}` });
      expect(enable.status, await bodyText(enable)).toBe(200);
      const actingToken = ((await enable.json()) as { token: string }).token;

      // A SECOND device logs in with 2FA (consumes step) — its cookie must die when the acting device disables.
      const other = await post(env, '/api/auth/login', { username: 'tfa-off', password: 'tfa-off-pass-1', totp: codeAtStep(secretBytes, step) });
      expect(other.status, await bodyText(other)).toBe(200);
      const otherCookie = refreshCookieValue(other)!;

      // Disable with the acting token, re-proving step+1 (> lastAcceptedStep=step) — revoke-all THEN re-issue.
      const disable = await post(env, '/api/auth/totp/disable', { code: codeAtStep(secretBytes, step + 1) }, { Authorization: `Bearer ${actingToken}` });
      expect(disable.status, await bodyText(disable)).toBe(200);
      const dbody = (await disable.json()) as { enabled: boolean; token: string };
      expect(dbody.enabled).toBe(false);
      expect(dbody.token).toMatch(/.+/);

      // Acting device stays signed in (fresh cookie refreshes); the other device's cookie is revoked.
      const freshCookie = refreshCookieValue(disable)!;
      expect((await post(env, '/api/auth/refresh', {}, cookieHeader(freshCookie))).status).toBe(200);
      expect((await post(env, '/api/auth/refresh', {}, cookieHeader(otherCookie))).status).toBe(401);
    },
    T,
  );
});

// ===========================================================================
// #41 — totpEnabled surfaced on the session-establishing responses (login + refresh) so the Settings
//        screen renders 2FA state server-authoritatively (the client never infers it).
// ===========================================================================
describe('#41 — totpEnabled on auth responses', () => {
  it(
    'login carries totpEnabled=false for an account without 2FA',
    async () => {
      const env = makeEnv(freshDb());
      await signup(env, 'no-tfa', 'no-tfa-password-1');
      const login = await post(env, '/api/auth/login', { username: 'no-tfa', password: 'no-tfa-password-1' });
      expect(login.status, await bodyText(login)).toBe(200);
      expect(((await login.json()) as { totpEnabled: boolean }).totpEnabled).toBe(false);
    },
    T,
  );

  it(
    'login carries totpEnabled=true once 2FA is enabled',
    async () => {
      const env = makeEnv(freshDb());
      const acct = await signup(env, 'with-tfa', 'with-tfa-password-1');
      const { secret } = (await (
        await post(env, '/api/auth/totp/setup', {}, { Authorization: `Bearer ${acct.token}` })
      ).json()) as { secret: string };
      const secretBytes = base32ToBytes(secret);
      const step = stepAt(Date.now());
      // Enable on step-1 so the replay guard leaves the current step free for the login below.
      expect(
        (await post(env, '/api/auth/totp/verify', { code: codeAtStep(secretBytes, step - 1) }, { Authorization: `Bearer ${acct.token}` })).status,
      ).toBe(200);
      const login = await post(env, '/api/auth/login', {
        username: 'with-tfa',
        password: 'with-tfa-password-1',
        totp: codeAtStep(secretBytes, step),
      });
      expect(login.status, await bodyText(login)).toBe(200);
      expect(((await login.json()) as { totpEnabled: boolean }).totpEnabled).toBe(true);
    },
    T,
  );

  it(
    'refresh carries the server-authoritative totpEnabled (false for a plain account)',
    async () => {
      const env = makeEnv(freshDb());
      await signup(env, 'refresh-tfa', 'refresh-tfa-pass-1');
      const login = await post(env, '/api/auth/login', { username: 'refresh-tfa', password: 'refresh-tfa-pass-1' });
      const cookie = refreshCookieValue(login)!;
      const refreshed = await post(env, '/api/auth/refresh', {}, cookieHeader(cookie));
      expect(refreshed.status, await bodyText(refreshed)).toBe(200);
      expect(((await refreshed.json()) as { totpEnabled: boolean }).totpEnabled).toBe(false);
    },
    T,
  );
});

// ===========================================================================
// AP-T9 — TOTP confirm-before-activate + replay guard + encrypted-at-rest
// ===========================================================================
describe('AP-T9 — TOTP', () => {
  async function setupTotp(env: Env, token: string) {
    const res = await post(env, '/api/auth/totp/setup', {}, { Authorization: `Bearer ${token}` });
    expect(res.status, await bodyText(res)).toBe(200);
    const body = (await res.json()) as { secret: string; otpauthUri: string };
    return body;
  }

  it(
    'setup does NOT enable 2FA until a confirm code (confirm-before-activate); then login requires TOTP',
    async () => {
      const raw = freshDb();
      const env = makeEnv(raw);
      const acct = await signup(env, 'mara', 'mara-password-1');
      const { secret } = await setupTotp(env, acct.token);

      // After setup-without-confirm, the credential is NOT enabled (login still works without a code).
      const enabledRow1 = raw.prepare('SELECT totpEnabled, totpSecretEnc FROM passwordCredentials WHERE accountId=?')
        .get(acct.accountId) as { totpEnabled: number; totpSecretEnc: string | null };
      expect(enabledRow1.totpEnabled).toBe(0);
      // Secret is stored ENCRYPTED (ciphertext ≠ the base32 plaintext).
      expect(enabledRow1.totpSecretEnc).toBeTruthy();
      expect(enabledRow1.totpSecretEnc).not.toContain(secret);

      // Confirm with a valid code → activate. Use the PRIOR step's code (still valid under ±1 skew) so
      // the replay guard advances to step-1, leaving the current step free for the login below — exactly
      // how a real confirm-then-login a beat later behaves (different time windows).
      const secretBytes = base32ToBytes(secret);
      const verify = await post(
        env,
        '/api/auth/totp/verify',
        { code: codeAtStep(secretBytes, stepAt(Date.now()) - 1) },
        { Authorization: `Bearer ${acct.token}` },
      );
      expect(verify.status, await bodyText(verify)).toBe(200);

      // Now login WITHOUT a code fails; WITH a fresh (current-step) code succeeds.
      const noCode = await post(env, '/api/auth/login', { username: 'mara', password: 'mara-password-1' });
      expect(noCode.status).toBe(401);
      const withCode = await post(env, '/api/auth/login', {
        username: 'mara',
        password: 'mara-password-1',
        totp: codeAtStep(secretBytes, stepAt(Date.now())),
      });
      expect(withCode.status, await bodyText(withCode)).toBe(200);
    },
    T,
  );

  it(
    'P0 REGRESSION: a CORRECT password on a 2FA account WITHOUT a code returns totp_required (not the uniform invalid) so the client prompts; a WRONG code returns totp_invalid; a wrong PASSWORD stays uniform',
    async () => {
      const raw = freshDb();
      const env = makeEnv(raw);
      const acct = await signup(env, 'priya', 'priya-password-1');
      const { secret } = await setupTotp(env, acct.token);
      const secretBytes = base32ToBytes(secret);
      const step = stepAt(Date.now());
      // enable on step-1 so the current step is free for the login below
      expect((await post(env, '/api/auth/totp/verify', { code: codeAtStep(secretBytes, step - 1) }, { Authorization: `Bearer ${acct.token}` })).status).toBe(200);

      // correct password, NO code → 401 totp_required (the bug: this used to be uniform invalid_credentials,
      // so the client showed "wrong password" and never prompted for the code → 2FA accounts bricked).
      const noCode = await post(env, '/api/auth/login', { username: 'priya', password: 'priya-password-1' });
      expect(noCode.status).toBe(401);
      expect(((await noCode.json()) as { error: { code: string } }).error.code).toBe('totp_required');

      // correct password, WRONG code → 401 totp_invalid (client re-prompts with an error).
      const badCode = await post(env, '/api/auth/login', { username: 'priya', password: 'priya-password-1', totp: '000000' });
      expect(badCode.status).toBe(401);
      expect(((await badCode.json()) as { error: { code: string } }).error.code).toBe('totp_invalid');

      // WRONG password → stays UNIFORM invalid_credentials (no leak that 2FA is enabled / that the user exists).
      const badPass = await post(env, '/api/auth/login', { username: 'priya', password: 'wrong-password-xx', totp: codeAtStep(secretBytes, step) });
      expect(badPass.status).toBe(401);
      expect(((await badPass.json()) as { error: { code: string } }).error.code).toBe('invalid_credentials');

      // correct password + correct code → 200 (full login succeeds).
      const ok = await post(env, '/api/auth/login', { username: 'priya', password: 'priya-password-1', totp: codeAtStep(secretBytes, step) });
      expect(ok.status, await bodyText(ok)).toBe(200);
    },
    T,
  );

  it(
    'an invalid confirm code does NOT activate 2FA',
    async () => {
      const raw = freshDb();
      const env = makeEnv(raw);
      const acct = await signup(env, 'nina', 'nina-password-1');
      await setupTotp(env, acct.token);
      const verify = await post(env, '/api/auth/totp/verify', { code: '000000' }, { Authorization: `Bearer ${acct.token}` });
      expect(verify.status).toBe(400);
      const row = raw.prepare('SELECT totpEnabled FROM passwordCredentials WHERE accountId=?').get(acct.accountId) as { totpEnabled: number };
      expect(row.totpEnabled).toBe(0);
    },
    T,
  );

  it(
    'REPLAY GUARD: the same code cannot be reused for a second login',
    async () => {
      const raw = freshDb();
      const env = makeEnv(raw);
      const acct = await signup(env, 'omar', 'omar-password-1');
      const { secret } = await setupTotp(env, acct.token);
      const secretBytes = base32ToBytes(secret);
      const step = stepAt(Date.now());
      const code = codeAtStep(secretBytes, step);
      // confirm-before-activate consumes `step` as the initial lastAcceptedStep
      expect((await post(env, '/api/auth/totp/verify', { code }, { Authorization: `Bearer ${acct.token}` })).status).toBe(200);
      // a login reusing that SAME code (== lastAcceptedStep) is rejected by the replay guard
      const replay = await post(env, '/api/auth/login', { username: 'omar', password: 'omar-password-1', totp: code });
      expect(replay.status).toBe(401);
    },
    T,
  );
});

// ===========================================================================
// AP-T10 — recovery reset succeeds with the right phrase; reset clears 2FA (phrase-clears-2FA)
// ===========================================================================
describe('AP-T10 — recovery reset', () => {
  it(
    'the correct phrase resets the password and CLEARS 2FA (phrase = single master recovery)',
    async () => {
      const raw = freshDb();
      const env = makeEnv(raw);
      const acct = await signup(env, 'paul', 'paul-old-password');
      // enable 2FA
      const setup = (await (await post(env, '/api/auth/totp/setup', {}, { Authorization: `Bearer ${acct.token}` })).json()) as { secret: string };
      const code = codeAtStep(base32ToBytes(setup.secret), stepAt(Date.now()));
      expect((await post(env, '/api/auth/totp/verify', { code }, { Authorization: `Bearer ${acct.token}` })).status).toBe(200);

      // reset with the recovery phrase
      const reset = await post(env, '/api/auth/reset', {
        username: 'paul',
        recoveryPhrase: acct.recoveryPhrase,
        newPassword: 'paul-new-password',
      });
      expect(reset.status, await bodyText(reset)).toBe(200);

      // 2FA is cleared → the new password logs in WITHOUT a TOTP code
      const row = raw.prepare('SELECT totpEnabled, totpSecretEnc FROM passwordCredentials WHERE accountId=?')
        .get(acct.accountId) as { totpEnabled: number; totpSecretEnc: string | null };
      expect(row.totpEnabled).toBe(0);
      expect(row.totpSecretEnc).toBeNull();
      expect((await post(env, '/api/auth/login', { username: 'paul', password: 'paul-new-password' })).status).toBe(200);
    },
    T,
  );

  it(
    'BUG-2 (data-state vs code): a FRESH registration → establish recovery → /reset with the ORIGINAL phrase VERIFIES',
    async () => {
      // Settles the incident question: is reset-401 a CODE bug (hits every account incl a brand-new one)
      // or a DATA-STATE bug (only an older account whose recoveryPhc was bound under a different accountId
      // by an earlier identity migration)? This drives the EXACT sequence — register → /recovery/rotate
      // (establish, capturing the phrase verbatim as the client received it) → /finalize → /reset with that
      // ORIGINAL phrase. It is GREEN → the establish↔reset path is correct end-to-end (same accountId in
      // the peppered pre-image on both sides), so a fresh account's original phrase always verifies. A live
      // reset-401 is therefore DATA-STATE (a stale accountId↔verifier binding), not a code bug.
      const env = makeEnv(freshDb());
      const reg = await post(env, '/api/auth/signup', { username: 'fresh-reset', password: 'fresh-reset-pass-1' });
      expect(reg.status, await bodyText(reg)).toBe(201);
      const { token } = (await reg.json()) as { token: string };
      const rot = await post(env, '/api/auth/recovery/rotate', {}, { Authorization: `Bearer ${token}` });
      expect(rot.status, await bodyText(rot)).toBe(200);
      const { recoveryPhrase } = (await rot.json()) as { recoveryPhrase: string };
      expect((await post(env, '/api/auth/finalize', {}, { Authorization: `Bearer ${token}` })).status).toBe(200);

      const reset = await post(env, '/api/auth/reset', {
        username: 'fresh-reset',
        recoveryPhrase, // the ORIGINAL phrase, verbatim
        newPassword: 'fresh-reset-pass-2',
      });
      expect(reset.status, await bodyText(reset)).toBe(200); // verifies → code path is correct
      // the new password logs in (reset fully succeeded).
      expect((await post(env, '/api/auth/login', { username: 'fresh-reset', password: 'fresh-reset-pass-2' })).status).toBe(200);
    },
    T,
  );

  it(
    'reset is gated AT LEAST as hard as login (stricter backoff engages sooner)',
    async () => {
      const raw = freshDb();
      const env = makeEnv(raw);
      await signup(env, 'rosa', 'rosa-password-1');
      const store = createAuthStore(d1Adapter(d1Over(raw)));
      // 3 failed resets (RESET_BACKOFF.freeAttempts=2) → the bucket is now throttled.
      for (let i = 0; i < 3; i++) {
        await post(env, '/api/auth/reset', {
          username: 'rosa',
          recoveryPhrase: 'aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh',
          newPassword: 'whatever-pass-1',
        });
      }
      const throttle = await store.getThrottle('reset:rosa');
      expect(throttle).not.toBeNull();
      expect(throttle!.nextAllowedMs).toBeGreaterThan(Date.now());
    },
    T,
  );
});

// ===========================================================================
// AP-T12 (worker-observable slice) — no reusable bearer at rest beyond the httpOnly cookie + hashed refresh
// ===========================================================================
describe('AP-T12 — no raw bearer at rest (server side)', () => {
  it(
    'neither the access token nor the raw refresh token is stored — only hashes',
    async () => {
      const raw = freshDb();
      const env = makeEnv(raw);
      const login = await signup(env, 'sara', 'sara-password-1');
      const refreshRes = await post(env, '/api/auth/login', { username: 'sara', password: 'sara-password-1' });
      const rt = refreshCookieValue(refreshRes)!;
      // access token never persisted raw (grants store tokenHash only)
      const grants = raw.prepare('SELECT tokenHash FROM grants').all() as Array<{ tokenHash: string }>;
      expect(grants.some((g) => g.tokenHash === login.token)).toBe(false);
      // refresh token never persisted raw
      const sessions = raw.prepare('SELECT tokenHash FROM refreshSessions').all() as Array<{ tokenHash: string }>;
      expect(sessions.some((s) => s.tokenHash === rt)).toBe(false);
    },
    T,
  );
});

// ===========================================================================
// P0 BELT (spec §P0) — abandoned-signup recoverability: no silent re-auth, forced fresh-phrase on login
// ===========================================================================
describe('P0 belt — recoveryEstablished', () => {
  it(
    'a finalized account logs in normally: recoveryEstablished=true + durable cookie',
    async () => {
      const env = makeEnv(freshDb());
      await signup(env, 'fin-user', 'fin-password-1'); // signup() finalizes
      const login = await post(env, '/api/auth/login', { username: 'fin-user', password: 'fin-password-1' });
      expect(login.status, await bodyText(login)).toBe(200);
      const body = (await login.json()) as { recoveryEstablished: boolean };
      expect(body.recoveryEstablished).toBe(true);
      expect(refreshCookieValue(login)).toBeTruthy();
    },
    T,
  );

  it(
    'an ABANDONED signup (no finalize) logs in with recoveryEstablished=false and NO durable cookie (forces the phrase screen)',
    async () => {
      const env = makeEnv(freshDb());
      await signupNoFinalize(env, 'abandoner', 'abandon-pass-1');
      const login = await post(env, '/api/auth/login', { username: 'abandoner', password: 'abandon-pass-1' });
      expect(login.status, await bodyText(login)).toBe(200);
      const body = (await login.json()) as { recoveryEstablished: boolean };
      // The belt: login succeeds but signals the client to force the recovery-phrase screen ...
      expect(body.recoveryEstablished).toBe(false);
      // ... and grants NO durable cookie (no silent cross-boot re-auth for an unrecoverable account).
      expect(refreshCookieValue(login)).toBeNull();
    },
    T,
  );

  it(
    'the forced-phrase flow: /recovery/rotate mints a FRESH phrase that resets work; then /finalize establishes recovery',
    async () => {
      const raw = freshDb();
      const env = makeEnv(raw);
      const acct = await signupNoFinalize(env, 'rotator', 'rotate-pass-1');

      // Before rotate, recovery is the fails-closed sentinel — a reset can never succeed AND must burn the
      // dummy Argon2id (no fast-path timing oracle for the un-established state — secSys (a)).
      const t0 = Date.now();
      const pre = await post(env, '/api/auth/reset', { username: 'rotator', recoveryPhrase: 'aaaa-bbbb-cccc-dddd', newPassword: 'np-pre-1' });
      expect(pre.status).toBe(401);
      expect(Date.now() - t0).toBeGreaterThan(50); // dummy hash ran (sentinel routed through the dummy branch)

      // Establish recovery via rotate (Option B: the register happy-path phrase source).
      const rotateRes = await post(env, '/api/auth/recovery/rotate', {}, { Authorization: `Bearer ${acct.token}` });
      expect(rotateRes.status, await bodyText(rotateRes)).toBe(200);
      const { recoveryPhrase: freshPhrase } = (await rotateRes.json()) as { recoveryPhrase: string };
      expect(freshPhrase).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4})+$/);
      // rotate alone does NOT establish recovery (flag flips only at ack/finalize)
      expect(
        (raw.prepare('SELECT recoveryEstablished FROM passwordCredentials WHERE accountId=?').get(acct.accountId) as {
          recoveryEstablished: number;
        }).recoveryEstablished,
      ).toBe(0);

      // Finalize (after the ack) establishes recovery + sets the durable cookie. Done BEFORE the reset
      // assertions below, since a successful reset revoke-alls this access token.
      const fin = await post(env, '/api/auth/finalize', {}, { Authorization: `Bearer ${acct.token}` });
      expect(fin.status, await bodyText(fin)).toBe(200);
      expect(refreshCookieValue(fin)).toBeTruthy();

      // The FRESH phrase resets; a wrong phrase does not.
      expect(
        (await post(env, '/api/auth/reset', { username: 'rotator', recoveryPhrase: 'wxyz-wxyz-wxyz-wxyz', newPassword: 'np-old-1' })).status,
      ).toBe(401);
      expect(
        (await post(env, '/api/auth/reset', { username: 'rotator', recoveryPhrase: freshPhrase, newPassword: 'np-fresh-1' })).status,
      ).toBe(200);
    },
    T,
  );
});
