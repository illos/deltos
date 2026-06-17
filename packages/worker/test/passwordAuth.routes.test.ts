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
  recoveryPhrase: string;
  token: string;
  expiresAt: string;
}
async function signup(env: Env, username: string, password: string): Promise<SignupResult> {
  const res = await post(env, '/api/auth/signup', { username, password });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = (await res.json()) as SignupResult;
  // Simulate the user save-acking the recovery phrase → FINALIZE, so the account is fully recoverable
  // and subsequent logins behave normally (durable cookie + recoveryEstablished=true). The access token
  // stays valid across finalize. Tests of the ABANDONED path (no finalize) call /signup directly instead.
  const fin = await post(env, '/api/auth/finalize', {}, { Authorization: `Bearer ${body.token}` });
  expect(fin.status, await fin.clone().text()).toBe(200);
  return body;
}

/** Sign up WITHOUT finalizing — the abandoned-registration path (phrase never save-acked). */
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
    'creates an account, claims the username, returns the phrase + access token, but NO durable cookie (P0 suspenders)',
    async () => {
      const env = makeEnv(freshDb());
      const res = await post(env, '/api/auth/signup', { username: 'Alice', password: 'correct-horse' });
      expect(res.status, await bodyText(res)).toBe(201);
      const body = (await res.json()) as SignupResult;
      expect(body.accountId).toMatch(/.+/);
      expect(body.username).toBe('Alice'); // display form preserved
      expect(body.recoveryPhrase).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4})+$/);
      expect(body.token).toMatch(/.+/);
      // P0 SUSPENDERS: signup must NOT set the durable refresh cookie (cross-boot durability waits for finalize).
      expect(refreshCookieValue(res)).toBeNull();
    },
    T,
  );

  it(
    'FINALIZE sets recoveryEstablished + the durable refresh cookie (httpOnly+Secure+SameSite=Strict, /refresh-scoped)',
    async () => {
      const raw = freshDb();
      const env = makeEnv(raw);
      const signupRes = await post(env, '/api/auth/signup', { username: 'finalizer', password: 'finalize-pass-1' });
      const body = (await signupRes.json()) as SignupResult;
      // before finalize: recoveryEstablished is false on the row
      expect(
        (raw.prepare('SELECT recoveryEstablished FROM passwordCredentials WHERE accountId=?').get(body.accountId) as {
          recoveryEstablished: number;
        }).recoveryEstablished,
      ).toBe(0);

      const fin = await post(env, '/api/auth/finalize', {}, { Authorization: `Bearer ${body.token}` });
      expect(fin.status, await bodyText(fin)).toBe(200);
      // now the durable cookie is set with the right attributes (AP-8) ...
      const sc = setCookieHeaders(fin).find((s) => s.startsWith('deltos_rt='));
      expect(sc).toBeDefined();
      expect(sc).toMatch(/HttpOnly/i);
      expect(sc).toMatch(/Secure/i);
      expect(sc).toMatch(/SameSite=Strict/i);
      expect(sc).toMatch(/Path=\/api\/auth\/refresh/i);
      // ... and the flag flipped true
      expect(
        (raw.prepare('SELECT recoveryEstablished FROM passwordCredentials WHERE accountId=?').get(body.accountId) as {
          recoveryEstablished: number;
        }).recoveryEstablished,
      ).toBe(1);
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

      // The original signup phrase is abandoned; rotate to a fresh one (the forced screen).
      const rotateRes = await post(env, '/api/auth/recovery/rotate', {}, { Authorization: `Bearer ${acct.token}` });
      expect(rotateRes.status, await bodyText(rotateRes)).toBe(200);
      const { recoveryPhrase: freshPhrase } = (await rotateRes.json()) as { recoveryPhrase: string };
      expect(freshPhrase).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4})+$/);
      expect(freshPhrase).not.toBe(acct.recoveryPhrase);
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

      // The FRESH phrase is the one that now works for reset (verifier was rotated); the OLD one does not.
      expect(
        (await post(env, '/api/auth/reset', { username: 'rotator', recoveryPhrase: acct.recoveryPhrase, newPassword: 'np-old-1' })).status,
      ).toBe(401);
      expect(
        (await post(env, '/api/auth/reset', { username: 'rotator', recoveryPhrase: freshPhrase, newPassword: 'np-fresh-1' })).status,
      ).toBe(200);
    },
    T,
  );
});
