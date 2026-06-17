import { create } from 'zustand';
import type { AccessTokenResponse, RegisterResponse, TotpSetupResponse } from '@deltos/shared';

/**
 * Client auth store — USERNAME + PASSWORD (auth pivot; supersedes the passkey/WebAuthn stack).
 *
 * Durable session, NO token at rest (the load-bearing answer to "ungated day-to-day + survives reload"):
 *   - The ACCESS token (`bearerToken`) is the `Authorization: Bearer` the sync engine sends. It lives
 *     ONLY here, in memory — never IndexedDB / localStorage / cache. Lost on reload, by design.
 *   - The REFRESH bearer is an httpOnly + Secure + SameSite=Strict cookie scoped to /refresh that JS
 *     CANNOT read. On cold boot {@link init} rides POST /api/auth/refresh (the browser attaches the
 *     cookie automatically, same-origin) to re-mint a fresh access token → the app opens to notes with
 *     NO prompt (reproduces the old passkey silent re-mint; survives reload + iOS storage eviction).
 *   - Net stronger vs XSS than the old wrapped-key-in-IDB: there is no reusable secret JS can exfiltrate.
 *
 * Day-to-day is UNGATED — password is for register / new-device login / reset only, never an app-open
 * prompt. The ONLY blocking auth screen is the register/login gate when there is NO durable session.
 *
 * P0 LATCH (carry the enroll-unmount lesson forward): the boot gate opens to the shell only when
 * `isAuthed && !isAuthing`. A route runs a ceremony as: {@link beginAuth} (isAuthing=true) → action →
 * [show the recovery phrase, for register] → {@link finalizeAuth} (isAuthing=false + isAuthed=true, one
 * update). isAuthed therefore flips to the shell ONLY at ceremony-complete, on EVERY path; and
 * isAuthing pins the route even if a background {@link init} refresh resolves mid-ceremony. Never open
 * the shell at an intermediate step, or the gate unmounts the route mid-ceremony (the P0 bug class).
 */

const API = '/api/auth';

/** Detailed session status — drives the quiet status pill + the sync-on-active trigger. Never gates. */
export type SessionState = 'booting' | 'active' | 'unauthed' | 'offline';

export interface AuthState {
  /** Boot-gate input: null = booting (resolving /refresh); else see the shell rule (isAuthed && !isAuthing). */
  isAuthed: boolean | null;
  /** A live auth ceremony (register/login/reset) is in progress THIS session — the gate-pin latch. */
  isAuthing: boolean;
  /** In-memory ACCESS token (Authorization: Bearer). NEVER persisted. null = no live session this tick. */
  bearerToken: string | null;
  /** The signed-in account (data-ownership key; the data layer scopes on this, never the credential). */
  accountId: string | null;
  /** The login identifier / public-ish handle. */
  username: string | null;
  sessionState: SessionState;
  error: string | null;
}

export type RegisterResult =
  | { ok: true; recoveryPhrase: string }
  | { ok: false; code: 'username_taken' | 'weak_password' | 'invalid' | 'rate_limited' | 'network' };
export type LoginResult =
  | { ok: true }
  | { ok: false; code: 'invalid' | 'totp_required' | 'totp_invalid' | 'rate_limited' | 'network' };
export type ResetResult =
  | { ok: true }
  | { ok: false; code: 'invalid' | 'rate_limited' | 'network' };
export type TotpSetupResult =
  | { ok: true; secret: string; uri: string }
  | { ok: false; code: 'invalid' | 'network' };
export type TotpVerifyResult = { ok: true } | { ok: false; code: 'totp_invalid' | 'network' };

export interface AuthActions {
  /**
   * Cold boot: ride the httpOnly refresh cookie (POST /refresh, no body) to re-mint an in-memory
   * access token. Success → isAuthed true (UNGATED). No/expired cookie → isAuthed false (the gate).
   * Resolves fast; the shell renders off the gate rule. Never throws. Suppressed while a ceremony runs.
   */
  init(): Promise<void>;
  /** Create the account + mint the session; returns the recovery phrase to show ONCE. Does NOT open the
   *  shell — the route shows + has the user acknowledge the phrase, then calls finalizeAuth. */
  register(username: string, password: string, turnstileToken?: string): Promise<RegisterResult>;
  /** Username + password (+ TOTP if enabled). Uniform 'invalid' on any wrong credential (no enumeration);
   *  code 'totp_required' = prompt for the 2FA code then call again. On ok the session is minted (the
   *  route then calls finalizeAuth to open the shell). */
  login(username: string, password: string, totp?: string, turnstileToken?: string): Promise<LoginResult>;
  /** Revoke-all server-side + clear the in-memory session. Gate → closed. */
  logout(): Promise<void>;
  /** Username + recovery phrase → set a new password (+ clear/re-enrol 2FA), revoke-all, sign in.
   *  NON-DISCLOSING: a wrong username/phrase returns the same uniform 'invalid'. */
  resetWithPhrase(username: string, phrase: string, newPassword: string, turnstileToken?: string): Promise<ResetResult>;
  /** Begin TOTP enrolment (authed) — returns the shared secret + otpauth URI for the QR. Does NOT enable
   *  2FA; enable only happens on a confirmed code via {@link verifyTotp} (anti-lockout). */
  setupTotp(): Promise<TotpSetupResult>;
  /** Confirm a code from the authenticator app → ENABLE TOTP (only here, after a valid code). */
  verifyTotp(code: string): Promise<TotpVerifyResult>;
  /** Ceremony latch: a route MUST call this at ceremony start (pins the gate to the auth route). */
  beginAuth(): void;
  /** Ceremony-complete latch flip: clears isAuthing + opens the shell (isAuthed=true), in one update. */
  finalizeAuth(): void;
  clearError(): void;
}

/** Authed JSON fetch (same-origin → the refresh cookie rides automatically; the access token bearers). */
function authFetch(path: string, body?: unknown, token?: string | null): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export const useAuthStore = create<AuthState & AuthActions>((set, get) => ({
  isAuthed: null,
  isAuthing: false,
  bearerToken: null,
  accountId: null,
  username: null,
  sessionState: 'booting',
  error: null,

  async init() {
    try {
      const res = await authFetch('/refresh');
      if (!res.ok) { if (!get().isAuthing) set({ isAuthed: false, sessionState: 'unauthed' }); return; }
      const s = (await res.json()) as AccessTokenResponse;
      // A live ceremony owns the gate — don't let a background refresh open the shell underneath it.
      const opening = get().isAuthing ? {} : { isAuthed: true, sessionState: 'active' as const };
      set({ bearerToken: s.token, accountId: s.accountId, username: s.username, ...opening });
    } catch {
      // Network failure on cold boot — no session to render, but it isn't a credential failure.
      if (!get().isAuthing) set({ isAuthed: false, sessionState: 'offline' });
    }
  },

  async register(username, password, turnstileToken) {
    set({ error: null });
    let res: Response;
    // NOTE: the worker mounts password-register at /signup (collision-free additive landing — the
    // legacy signed-challenge /register is still mounted alongside it; see passwordAuth.ts). Stay on
    // /signup until devSys retires the legacy auth router and confirms the final path.
    try { res = await authFetch('/signup', { username, password, ...(turnstileToken ? { turnstileToken } : {}) }); }
    catch { return { ok: false, code: 'network' }; }
    if (!res.ok) {
      const code = res.status === 409 ? 'username_taken'
        : res.status === 429 ? 'rate_limited'
        : res.status === 400 ? 'weak_password'
        : 'invalid';
      return { ok: false, code };
    }
    const s = (await res.json()) as RegisterResponse;
    // Session minted, but the shell stays closed until finalizeAuth (the recovery phrase must be shown +
    // acknowledged first — the P0 anti-unmount discipline). The route runs beginAuth → register → ack →
    // finalizeAuth; isAuthing is already set by beginAuth.
    set({ bearerToken: s.token, accountId: s.accountId, username: s.username });
    return { ok: true, recoveryPhrase: s.recoveryPhrase };
  },

  async login(username, password, totp, turnstileToken) {
    set({ error: null });
    let res: Response;
    try { res = await authFetch('/login', { username, password, ...(totp ? { totp } : {}), ...(turnstileToken ? { turnstileToken } : {}) }); }
    catch { return { ok: false, code: 'network' }; }
    if (!res.ok) {
      if (res.status === 429) return { ok: false, code: 'rate_limited' };
      const raw = await res.json().catch(() => ({})) as { error?: { code?: string } };
      const c = raw.error?.code;
      if (c === 'totp_required') return { ok: false, code: 'totp_required' };
      if (c === 'totp_invalid') return { ok: false, code: 'totp_invalid' };
      return { ok: false, code: 'invalid' }; // uniform — no username enumeration
    }
    const s = (await res.json()) as AccessTokenResponse;
    set({ bearerToken: s.token, accountId: s.accountId, username: s.username });
    return { ok: true };
  },

  async logout() {
    try { await authFetch('/logout', undefined, get().bearerToken); } catch { /* clear locally regardless */ }
    set({ bearerToken: null, accountId: null, username: null, isAuthed: false, isAuthing: false, sessionState: 'unauthed' });
  },

  async resetWithPhrase(username, phrase, newPassword, turnstileToken) {
    set({ error: null });
    let res: Response;
    try { res = await authFetch('/reset', { username, recoveryPhrase: phrase, newPassword, ...(turnstileToken ? { turnstileToken } : {}) }); }
    catch { return { ok: false, code: 'network' }; }
    if (!res.ok) {
      if (res.status === 429) return { ok: false, code: 'rate_limited' };
      return { ok: false, code: 'invalid' }; // non-disclosing — never confirms the username exists
    }
    const s = (await res.json()) as AccessTokenResponse;
    set({ bearerToken: s.token, accountId: s.accountId, username: s.username });
    return { ok: true };
  },

  async setupTotp() {
    let res: Response;
    try { res = await authFetch('/totp/setup', {}, get().bearerToken); }
    catch { return { ok: false, code: 'network' }; }
    if (!res.ok) return { ok: false, code: 'invalid' };
    const b = (await res.json()) as TotpSetupResponse;
    return { ok: true, secret: b.secret, uri: b.otpauthUri };
  },

  async verifyTotp(code) {
    let res: Response;
    try { res = await authFetch('/totp/verify', { code }, get().bearerToken); }
    catch { return { ok: false, code: 'network' }; }
    if (!res.ok) return { ok: false, code: 'totp_invalid' };
    return { ok: true };
  },

  beginAuth() { set({ isAuthing: true }); },
  finalizeAuth() { set({ isAuthing: false, isAuthed: true, sessionState: 'active' }); },
  clearError() { set({ error: null }); },
}));
