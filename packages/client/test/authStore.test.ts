/**
 * Client auth store — USERNAME + PASSWORD actions (auth pivot; supersedes the passkey enroll store).
 *
 * Proves, at the store layer (no DOM), the two load-bearing contracts:
 *   1. DURABLE SESSION, no token at rest — init() rides POST /refresh (the httpOnly cookie) on cold
 *      boot to re-mint the in-memory access token and open UNGATED; a failed/absent cookie → the gate;
 *      a network failure → offline (not a credential failure).
 *   2. P0 LATCH — register/login/reset mint the in-memory session but NEVER open the shell; the shell
 *      opens ONLY at finalizeAuth (which clears isAuthing). A background init() refresh that resolves
 *      while a ceremony is live must NOT flip the shell open underneath it (the enroll-unmount class).
 * Plus: discriminated {ok,code} results (no throws) so routes can render inline credential errors;
 * uniform/non-disclosing failures on login + reset.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAuthStore } from '../src/auth/store.js';

const DEFAULTS = {
  isAuthed: null as boolean | null,
  isAuthing: false,
  bearerToken: null as string | null,
  accountId: null as string | null,
  username: null as string | null,
  recoveryEstablished: null as boolean | null,
  totpEnabled: false,
  sessionState: 'booting' as const,
  error: null as string | null,
};

/** Minimal Response stand-in for the store's authFetch (only .ok/.status/.json are read). */
function res(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => Promise.resolve(handler(url, init))));
}
const SESSION = { token: 'access-tok', expiresAt: '2026-07-01T00:00:00Z', accountId: 'acct-1', username: 'ada', recoveryEstablished: true, totpEnabled: false };
/** A session for an account that never finalized a recovery phrase (the abandoned-signup belt edge). */
const SESSION_NO_RECOVERY = { ...SESSION, recoveryEstablished: false };
/** Route-aware fetch mock: /finalize + /recovery/rotate get their own response; everything else `rest`. */
function mockRoutes(map: Record<string, Response>, rest: Response) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const hit = Object.keys(map).find((p) => url.endsWith(p));
    return Promise.resolve(hit ? map[hit] : rest);
  }));
}

beforeEach(() => {
  useAuthStore.setState(DEFAULTS, false);
});
afterEach(() => vi.unstubAllGlobals());

const s = () => useAuthStore.getState();

describe('init() — cold-boot /refresh ride (ungated durable session)', () => {
  it('valid refresh cookie → in-memory token minted, shell OPEN (isAuthed true), active', async () => {
    mockFetch(() => res(200, SESSION));
    await s().init();
    expect(s().bearerToken).toBe('access-tok');
    expect(s().accountId).toBe('acct-1');
    expect(s().isAuthed).toBe(true);            // UNGATED open — no password prompt
    expect(s().sessionState).toBe('active');
  });

  it('no/expired refresh cookie (401) → the gate (isAuthed false, unauthed), no token', async () => {
    mockFetch(() => res(401));
    await s().init();
    expect(s().bearerToken).toBeNull();
    expect(s().isAuthed).toBe(false);
    expect(s().sessionState).toBe('unauthed');
  });

  it('network failure on cold boot → offline (NOT a credential failure), still no token', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    await s().init();
    expect(s().isAuthed).toBe(false);
    expect(s().sessionState).toBe('offline');
  });

  it('P0: a background refresh resolving DURING a ceremony does NOT open the shell', async () => {
    mockFetch(() => res(200, SESSION));
    s().beginAuth();                            // a route owns the gate
    await s().init();                           // background refresh resolves underneath
    expect(s().isAuthed).not.toBe(true);        // shell stays closed — the latch holds
    expect(s().isAuthing).toBe(true);
  });
});

describe('register() — mints session, does NOT open the shell (latch discipline)', () => {
  it('Option-B happy path: signup mints session (NO phrase) → establishRecovery → finalize opens shell', async () => {
    // single-hash signup: /signup returns just the session (no recoveryPhrase); the phrase is minted
    // by /recovery/rotate; /finalize (guarded) sets cookie + flag — identical to the forced-phrase flow.
    mockRoutes(
      { '/recovery/rotate': res(200, { recoveryPhrase: 'alpha bravo charlie' }), '/finalize': res(200, { ok: true }) },
      res(200, SESSION), // /signup — no recoveryPhrase on the body anymore
    );
    s().beginAuth();
    const r = await s().register('ada', 'password123');
    expect(r).toEqual({ ok: true });            // signup no longer carries a phrase
    expect(s().bearerToken).toBe('access-tok'); // session minted
    expect(s().recoveryEstablished).toBe(false);
    expect(s().isAuthed).not.toBe(true);        // shell closed until finalize
    const phrase = await s().establishRecovery();
    expect(phrase.ok && phrase.recoveryPhrase).toBe('alpha bravo charlie');
    expect(s().recoveryEstablished).toBe(false); // rotate does NOT set the flag
    expect(await s().finalizeAuth()).toEqual({ ok: true });
    expect(s().isAuthed).toBe(true);            // only after establish + finalize
    expect(s().isAuthing).toBe(false);
    expect(s().recoveryEstablished).toBe(true); // finalize set the flag
    expect(s().sessionState).toBe('active');
  });

  it('409 → {ok:false, code:username_taken} (register is the one disclosing endpoint)', async () => {
    mockFetch(() => res(409));
    expect(await s().register('ada', 'pw')).toEqual({ ok: false, code: 'username_taken' });
  });

  it('400 → weak_password; 429 → rate_limited; network throw → network', async () => {
    mockFetch(() => res(400));
    expect((await s().register('ada', 'x')).code === 'weak_password').toBe(true);
    mockFetch(() => res(429));
    expect((await s().register('ada', 'x')).code === 'rate_limited').toBe(true);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('x'))));
    expect((await s().register('ada', 'x')).code === 'network').toBe(true);
  });
});

describe('login() — uniform invalid; TOTP step behind a correct password', () => {
  it('success (recovery established) → {ok, recoveryRequired:false}; token set, shell NOT opened by login', async () => {
    mockFetch(() => res(200, SESSION));
    const r = await s().login('ada', 'password123');
    expect(r).toEqual({ ok: true, recoveryRequired: false });
    expect(s().bearerToken).toBe('access-tok');
    expect(s().isAuthed).not.toBe(true);        // the route opens the shell via finalizeAuth, not login
  });

  it('wrong credentials → UNIFORM {ok:false, code:invalid} (no enumeration)', async () => {
    mockFetch(() => res(401, { error: { code: 'bad_credentials' } }));
    expect(await s().login('ada', 'nope')).toEqual({ ok: false, code: 'invalid' });
  });

  it('totp_required / totp_invalid markers surface as their codes', async () => {
    mockFetch(() => res(401, { error: { code: 'totp_required' } }));
    expect((await s().login('ada', 'pw')).code).toBe('totp_required');
    mockFetch(() => res(401, { error: { code: 'totp_invalid' } }));
    expect((await s().login('ada', 'pw', '000000')).code).toBe('totp_invalid');
  });

  it('forwards the totp code only when supplied', async () => {
    let sent: Record<string, unknown> = {};
    mockFetch((_u, init) => { sent = JSON.parse(init.body as string); return res(200, SESSION); });
    await s().login('ada', 'pw', '123456');
    expect(sent.totp).toBe('123456');
  });
});

describe('resetWithPhrase() — non-disclosing', () => {
  it('failure → UNIFORM {ok:false, code:invalid} regardless of which factor was wrong', async () => {
    mockFetch(() => res(401));
    expect(await s().resetWithPhrase('ada', 'wrong phrase', 'newpassword1')).toEqual({ ok: false, code: 'invalid' });
  });
  it('success → {ok}; new in-memory session minted', async () => {
    mockFetch(() => res(200, SESSION));
    expect(await s().resetWithPhrase('ada', 'right phrase', 'newpassword1')).toEqual({ ok: true });
    expect(s().bearerToken).toBe('access-tok');
  });
});

describe('logout() — clears the in-memory session + closes the gate', () => {
  it('clears token/account and drops isAuthed to false even if the network call fails', async () => {
    useAuthStore.setState({ bearerToken: 'live', accountId: 'acct-1', isAuthed: true, sessionState: 'active' }, false);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    await s().logout();
    expect(s().bearerToken).toBeNull();
    expect(s().accountId).toBeNull();
    expect(s().isAuthed).toBe(false);
    expect(s().isAuthing).toBe(false);
  });
});

describe('TOTP setup/verify/disable — anti-lockout shape + totpEnabled mirror', () => {
  it('setupTotp returns the secret + otpauth uri (mapped to uri)', async () => {
    mockFetch(() => res(200, { secret: 'BASE32SECRET', otpauthUri: 'otpauth://totp/deltos:ada?secret=BASE32SECRET' }));
    useAuthStore.setState({ bearerToken: 'live' }, false);
    const r = await s().setupTotp();
    expect(r).toEqual({ ok: true, secret: 'BASE32SECRET', uri: 'otpauth://totp/deltos:ada?secret=BASE32SECRET' });
  });
  it('verifyTotp ok → flips totpEnabled true AND swaps to the re-issued access token (stays signed in)', async () => {
    useAuthStore.setState({ bearerToken: 'old-tok' }, false);
    mockFetch(() => res(200, { enabled: true, token: 'reissued-tok', expiresAt: 'x' }));
    expect(await s().verifyTotp('123456')).toEqual({ ok: true });
    expect(s().totpEnabled).toBe(true);          // mirrors the server enable without a round-trip
    expect(s().bearerToken).toBe('reissued-tok'); // revoke-others-+-reissue: acting device keeps a live token
    useAuthStore.setState({ totpEnabled: true }, false);
    mockFetch(() => res(400));
    expect(await s().verifyTotp('000000')).toEqual({ ok: false, code: 'totp_invalid' });
    expect(s().totpEnabled).toBe(true);          // a rejected code does NOT change state
  });
  it('disableTotp success → flips totpEnabled false, swaps the re-issued token, sends the re-prove code', async () => {
    let sent: Record<string, unknown> = {};
    mockFetch((_u, init) => { sent = JSON.parse(init.body as string); return res(200, { enabled: false, token: 'reissued-tok', expiresAt: 'x' }); });
    useAuthStore.setState({ bearerToken: 'old-tok', totpEnabled: true }, false);
    expect(await s().disableTotp('123456')).toEqual({ ok: true });
    expect(sent.code).toBe('123456');            // re-prove with a current code (anti-lockout symmetry)
    expect(s().totpEnabled).toBe(false);
    expect(s().bearerToken).toBe('reissued-tok'); // acting device stays signed in after the toggle
  });
  it('disableTotp wrong code → {ok:false, totp_invalid}; state unchanged', async () => {
    mockFetch(() => res(400, { error: { code: 'invalid_code' } }));
    useAuthStore.setState({ bearerToken: 'live', totpEnabled: true }, false);
    expect(await s().disableTotp('000000')).toEqual({ ok: false, code: 'totp_invalid' });
    expect(s().totpEnabled).toBe(true);
  });
  it('disableTotp when 2FA is not enabled → {ok:false, not_enabled}', async () => {
    mockFetch(() => res(400, { error: { code: 'totp_not_enabled' } }));
    useAuthStore.setState({ bearerToken: 'live', totpEnabled: false }, false);
    expect(await s().disableTotp('123456')).toEqual({ ok: false, code: 'not_enabled' });
  });
  it('disableTotp network throw → {ok:false, network}', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    useAuthStore.setState({ bearerToken: 'live', totpEnabled: true }, false);
    expect(await s().disableTotp('123456')).toEqual({ ok: false, code: 'network' });
    expect(s().totpEnabled).toBe(true);          // no optimistic flip on a failed call
  });
});

describe('totpEnabled — server-authoritative surfacing on session responses', () => {
  it('init() populates totpEnabled from the refresh response', async () => {
    mockFetch(() => res(200, { ...SESSION, totpEnabled: true }));
    await s().init();
    expect(s().totpEnabled).toBe(true);
  });
  it('login() populates totpEnabled from the login response', async () => {
    mockFetch(() => res(200, { ...SESSION, totpEnabled: true }));
    await s().login('ada', 'pw');
    expect(s().totpEnabled).toBe(true);
  });
  it('a response missing totpEnabled is treated as OFF (never render 2FA "on" from an absent field)', async () => {
    const { totpEnabled: _omit, ...noFlag } = SESSION;
    mockFetch(() => res(200, noFlag));
    await s().login('ada', 'pw');
    expect(s().totpEnabled).toBe(false);
  });
  it('logout() clears totpEnabled', async () => {
    useAuthStore.setState({ bearerToken: 'live', totpEnabled: true, isAuthed: true }, false);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(res(200, { ok: true }))));
    await s().logout();
    expect(s().totpEnabled).toBe(false);
  });
});

describe('beginAuth/finalizeAuth — the latch primitives', () => {
  it('beginAuth pins isAuthing; finalizeAuth POSTs /finalize then opens the shell in ONE update', async () => {
    mockFetch(() => res(200, { ok: true }));   // /finalize
    s().beginAuth();
    expect(s().isAuthing).toBe(true);
    expect(s().isAuthed).not.toBe(true);
    expect(await s().finalizeAuth()).toEqual({ ok: true });
    expect(s().isAuthing).toBe(false);
    expect(s().isAuthed).toBe(true);
    expect(s().sessionState).toBe('active');
  });

  it('finalize NETWORK failure → {ok:false}; shell STAYS closed (no cookie-less session leaks in)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    s().beginAuth();
    expect(await s().finalizeAuth()).toEqual({ ok: false, code: 'network' });
    expect(s().isAuthed).not.toBe(true);        // not opened
    expect(s().isAuthing).toBe(true);           // still latched — the route can retry
  });

  it('finalize 409 guard (no rotate ran first) → {ok:false, code:recovery_not_established}; stays closed', async () => {
    mockFetch(() => res(409, { error: { code: 'recovery_not_established' } }));
    s().beginAuth();
    expect(await s().finalizeAuth()).toEqual({ ok: false, code: 'recovery_not_established' });
    expect(s().isAuthed).not.toBe(true);
  });
});

// ── P0-BELT — force a recovery phrase before entry when none was finalized (cross-boot) ──────────────
describe('recoveryEstablished belt — no account left silently unrecoverable', () => {
  it('login on an account with NO finalized phrase → {ok, recoveryRequired:TRUE}; shell stays closed', async () => {
    mockFetch(() => res(200, SESSION_NO_RECOVERY));
    const r = await s().login('ada', 'password123');
    expect(r).toEqual({ ok: true, recoveryRequired: true });
    expect(s().recoveryEstablished).toBe(false);
    expect(s().isAuthed).not.toBe(true);        // the route force-routes to the forced-phrase screen
  });

  it('init() fail-safe: a refresh reporting recoveryEstablished=false leaves the flag false (→ recovery-gate)', async () => {
    mockFetch(() => res(200, SESSION_NO_RECOVERY));
    await s().init();
    expect(s().recoveryEstablished).toBe(false); // selectBootView routes this to the forced-phrase screen
  });

  it('establishRecovery() rotates to a FRESH phrase (does NOT set the flag — that waits for finalize)', async () => {
    mockFetch(() => res(200, { recoveryPhrase: 'fresh delta echo foxtrot' }));
    useAuthStore.setState({ bearerToken: 'live', recoveryEstablished: false }, false);
    const r = await s().establishRecovery();
    expect(r).toEqual({ ok: true, recoveryPhrase: 'fresh delta echo foxtrot' });
    expect(s().recoveryEstablished).toBe(false); // unchanged — only finalizeAuth flips it
  });

  it('forced-phrase flow e2e: login(req) → establishRecovery → finalizeAuth → flag true + shell open', async () => {
    mockRoutes(
      { '/recovery/rotate': res(200, { recoveryPhrase: 'fresh golf hotel india' }), '/finalize': res(200, { ok: true }) },
      res(200, SESSION_NO_RECOVERY),  // /login
    );
    s().beginAuth();
    const login = await s().login('ada', 'pw');
    expect(login).toEqual({ ok: true, recoveryRequired: true });
    const phrase = await s().establishRecovery();
    expect(phrase.ok && phrase.recoveryPhrase).toBe('fresh golf hotel india');
    expect(s().isAuthed).not.toBe(true);         // still gated through the phrase step
    expect(await s().finalizeAuth()).toEqual({ ok: true });
    expect(s().recoveryEstablished).toBe(true);
    expect(s().isAuthed).toBe(true);             // entered only after the fresh phrase was established+acked
  });
});
