import { create } from 'zustand';
import type { AccessTokenResponse, RegisterResponse, TotpSetupResponse } from '@deltos/shared';
import { ensureAccountScope, purgeAllLocalState, readAccountMarker } from '../db/accountScope.js';
import { suspendSync, flushPushQueue } from '../lib/syncEngine.js';

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
export type SessionState =
  | 'booting'
  | 'active'
  | 'unauthed'
  // #85 OFFLINE: /refresh threw (no network) but a resident account exists → local shell, sync AUTO-resumes
  // on reconnect (no re-login). UX: 'Offline — changes saved locally'.
  // #89 REVOKED: server reachable, /refresh returned a genuine 401 (cookie revoked/expired) + a resident
  // account → local shell with sync HARD-GATED. A revoked cookie can't /refresh, so this needs a FULL
  // re-login (does NOT auto-resume) — visibly DISTINCT from 'offline'. UX: 'Signed out — sign in to resume sync'.
  | 'offline'
  | 'revoked';

export interface AuthState {
  /** Boot-gate input: null = booting (resolving /refresh); else see the shell rule (isAuthed && !isAuthing). */
  isAuthed: boolean | null;
  /** A live auth ceremony (register/login/reset) is in progress THIS session — the gate-pin latch. */
  isAuthing: boolean;
  /** In-memory ACCESS token (Authorization: Bearer). NEVER persisted. null = no live session this tick. */
  bearerToken: string | null;
  /** The signed-in account (data-ownership key; the data layer scopes on this, never the credential). */
  accountId: string | null;
  /** The login identifier / public handle. */
  username: string | null;
  /**
   * Has this account FINALIZED a recovery phrase? (P0-belt — cross-boot, secSys finding.) An account
   * created but abandoned before the phrase save+ack has this FALSE; on any successful login (or a
   * fail-safe cold-boot refresh) we force the recovery-phrase screen BEFORE shell entry, so no account
   * is ever left silently unrecoverable. true (or null=unknown) → ungated as normal, never prompted.
   */
  recoveryEstablished: boolean | null;
  /**
   * Server-authoritative 2FA (TOTP) state — drives the Settings screen's on/off toggle. Populated from
   * every session-establishing response (login / refresh / reset) and flipped locally on a confirmed
   * enable ({@link AuthActions.verifyTotp}) or disable ({@link AuthActions.disableTotp}). The client never
   * infers it; default false (a fresh signup, or before the first response, has no enrolled secret).
   */
  totpEnabled: boolean;
  sessionState: SessionState;
  error: string | null;
}

// `challenge` = the server's failure-triggered Turnstile fired (challenge_required / challenge_failed):
// the surface must render the widget and the user re-submits with a token. Distinct from a credential error.
export type RegisterResult =
  // Option-B single-hash signup: signup mints the session only; the recovery phrase comes from
  // establishRecovery (/recovery/rotate) on the happy path — so no phrase rides this result.
  | { ok: true }
  | { ok: false; code: 'username_taken' | 'weak_password' | 'invalid' | 'rate_limited' | 'network' | 'challenge' };
export type LoginResult =
  /** recoveryRequired = the account has no finalized recovery phrase → route to the forced-phrase
   *  screen and DO NOT finalizeAuth until it is established+acked (the P0-belt). */
  | { ok: true; recoveryRequired: boolean }
  | { ok: false; code: 'invalid' | 'totp_required' | 'totp_invalid' | 'rate_limited' | 'network' | 'challenge' };
export type EstablishRecoveryResult =
  | { ok: true; recoveryPhrase: string }
  | { ok: false; code: 'invalid' | 'network' };
export type FinalizeResult =
  | { ok: true }
  // recovery_not_established = /finalize's secSys guard fired (no rotate ran first) — never on the
  // happy/forced paths, which always establishRecovery before finalize; surfaced for safety.
  | { ok: false; code: 'invalid' | 'network' | 'recovery_not_established' };
export type ResetResult =
  | { ok: true }
  | { ok: false; code: 'invalid' | 'rate_limited' | 'network' | 'challenge' };
export type TotpSetupResult =
  | { ok: true; secret: string; uri: string }
  | { ok: false; code: 'invalid' | 'network' };
export type TotpVerifyResult = { ok: true } | { ok: false; code: 'totp_invalid' | 'network' };
export type TotpDisableResult =
  | { ok: true }
  | { ok: false; code: 'totp_invalid' | 'not_enabled' | 'network' };

export interface AuthActions {
  /**
   * Cold boot: ride the httpOnly refresh cookie (POST /refresh, no body) to re-mint an in-memory
   * access token. Success → isAuthed true (UNGATED). No/expired cookie → isAuthed false (the gate).
   * Resolves fast; the shell renders off the gate rule. Never throws. Suppressed while a ceremony runs.
   */
  init(): Promise<void>;
  /**
   * Re-mint the in-memory access token MID-SESSION from the httpOnly refresh cookie. Unlike {@link init}
   * the shell is already open, so this NEVER touches the boot gate (isAuthed) or opens/closes the shell —
   * it only swaps the bearer (and lifts a prior 'offline'/'revoked' sessionState back to 'active' on
   * success). Bounded by {@link REFRESH_TIMEOUT_MS}. The sync engine calls it when a request is rejected
   * for an expired/revoked access token (a 403 on the sync routes — the 15-min access TTL elapsed). Returns:
   *   - 'ok'      — a fresh bearer is in memory; retry the request.
   *   - 'revoked' — the refresh cookie itself is dead (genuine 401), or re-points to another account →
   *                 the caller hard-gates sync (a full re-login is required, #89).
   *   - 'offline' — couldn't reach the server (network / timeout); stay offline, reconnect retries.
   */
  remintBearer(): Promise<'ok' | 'revoked' | 'offline'>;
  /** Create the account + mint the session; returns the recovery phrase to show ONCE. Does NOT open the
   *  shell — the route shows + has the user acknowledge the phrase, then calls finalizeAuth. */
  register(username: string, password: string, turnstileToken?: string): Promise<RegisterResult>;
  /** Username + password (+ TOTP if enabled). Uniform 'invalid' on any wrong credential (no enumeration);
   *  code 'totp_required' = prompt for the 2FA code then call again. On ok the session is minted; if
   *  recoveryRequired the route shows the forced-phrase screen, else it calls finalizeAuth to enter. */
  login(username: string, password: string, totp?: string, turnstileToken?: string): Promise<LoginResult>;
  /** Revoke-all server-side + clear the in-memory session. Gate → closed. */
  logout(): Promise<void>;
  /** Username + recovery phrase → set a new password (+ clear/re-enrol 2FA), revoke-all, sign in.
   *  NON-DISCLOSING: a wrong username/phrase returns the same uniform 'invalid'. */
  resetWithPhrase(username: string, phrase: string, newPassword: string, turnstileToken?: string): Promise<ResetResult>;
  /** Begin TOTP enrolment (authed) — returns the shared secret + otpauth URI for the QR. Does NOT enable
   *  2FA; enable only happens on a confirmed code via {@link verifyTotp} (anti-lockout). */
  setupTotp(): Promise<TotpSetupResult>;
  /** Confirm a code from the authenticator app → ENABLE TOTP (only here, after a valid code). On success
   *  flips local {@link AuthState.totpEnabled} to true (server is already authoritative). */
  verifyTotp(code: string): Promise<TotpVerifyResult>;
  /**
   * Disable TOTP 2FA — re-prove with a current code (`POST /totp/disable`). On success flips local
   * {@link AuthState.totpEnabled} to false. Requiring a current code mirrors {@link verifyTotp} (anti-
   * lockout symmetry); a user who lost the authenticator disables via the recovery-phrase reset, which
   * also clears 2FA. A 2FA change revoke-alls every session (other devices must re-auth) but RE-ISSUES
   * the acting device's session — the server returns a fresh access token which this action swaps into
   * {@link AuthState.bearerToken}, so a Settings toggle keeps the user signed in.
   */
  disableTotp(code: string): Promise<TotpDisableResult>;
  /** Forced-phrase belt: mint a FRESH recovery phrase (server) + update the verifier, returned to show
   *  ONCE on the forced screen. Does NOT finalize — the route shows the phrase, then calls finalizeAuth
   *  on save+ack. Used when login/init reports recoveryRequired (no finalized phrase). */
  establishRecovery(): Promise<EstablishRecoveryResult>;
  /** Ceremony latch: a route MUST call this at ceremony start (pins the gate to the auth route). */
  beginAuth(): void;
  /**
   * Ceremony-complete latch flip — clears isAuthing + opens the shell (isAuthed=true) + marks recovery
   * established, in one update. ASYNC: the durable refresh cookie + the server recoveryEstablished flag
   * are set at FINALIZE (cookie-at-finalize, planSys ruling — not at signup), so this awaits that
   * server commit before opening. Call it only after the phrase is saved+acked. AWAIT it in every
   * route + handle a {ok:false} (network) by staying on the screen so the user can retry — never open
   * the shell without the server finalize (that would leave a no-cookie, flag-false session).
   */
  finalizeAuth(): Promise<FinalizeResult>;
  clearError(): void;
}

/**
 * How long a /refresh may take before we stop waiting. A WEAK (not absent) network otherwise leaves the
 * boot fetch pending FOREVER → the blue spinner never clears (offline works because fetch rejects fast;
 * a weak link neither resolves nor rejects). Bounded → on timeout the cold boot falls into the resident-
 * shell offline open (#85) and re-mints on reconnect; mid-session {@link AuthActions.remintBearer} uses
 * the same bound. Tunable — do not bury the literal.
 *
 * 3s (not longer): the offline open is NOT a dead-end — the shell is fully usable from local Dexie and
 * self-heals to 'active' within ~one poll (~2s) once the link firms up (syncFetch 503 → re-mint). The
 * spinner is the only bad state, so bias to leaving it FAST. A healthy /refresh is <300ms, so 3s only
 * trips on a genuinely slow link — exactly where "in my notes now" beats waiting to start authed.
 */
export const REFRESH_TIMEOUT_MS = 3000;

/** Authed JSON fetch (same-origin → the refresh cookie rides automatically; the access token bearers).
 *  `timeoutMs` (when > 0) abort-bounds the request — used for the /refresh calls so a weak network can't
 *  hang the caller. A timeout aborts → fetch rejects (AbortError) → the caller's catch (offline path). */
function authFetch(path: string, body?: unknown, token?: string | null, timeoutMs?: number): Promise<Response> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  if (!timeoutMs || timeoutMs <= 0) return fetch(`${API}${path}`, init);
  // Manual AbortController (not AbortSignal.timeout) so the timer is driveable under fake timers in tests.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  init.signal = ctrl.signal;
  return fetch(`${API}${path}`, init).finally(() => clearTimeout(timer));
}

/** Read the recoveryEstablished flag off an auth response (on AccessTokenResponse: login + refresh).
 *  null = absent (never gate on an unknown — the belt only ever fires on an explicit server `false`). */
function readRecoveryFlag(s: { recoveryEstablished?: boolean }): boolean | null {
  return typeof s.recoveryEstablished === 'boolean' ? s.recoveryEstablished : null;
}

/** Read server-authoritative `totpEnabled` off an auth response. Default false: never render 2FA "on"
 *  from a missing field (an old/partial response → treat as off, the safe-to-display state). */
function readTotpFlag(s: { totpEnabled?: boolean }): boolean {
  return s.totpEnabled === true;
}

/** True when a server error code is the failure-triggered Turnstile signal (missing OR bad token). Both
 *  mean the same thing to the surface: render the widget, collect a token, retry. */
function isChallengeCode(code: string | undefined): boolean {
  return code === 'challenge_required' || code === 'challenge_failed';
}

export const useAuthStore = create<AuthState & AuthActions>((set, get) => ({
  isAuthed: null,
  isAuthing: false,
  bearerToken: null,
  accountId: null,
  username: null,
  recoveryEstablished: null,
  totpEnabled: false,
  sessionState: 'booting',
  error: null,

  async init() {
    try {
      const res = await authFetch('/refresh', undefined, undefined, REFRESH_TIMEOUT_MS);
      if (!res.ok) {
        if (get().isAuthing) return; // a live ceremony owns the gate
        // #89 (secSys Leg 2): a genuine 401 (revoked/expired refresh cookie) WITH a resident account →
        // open the LOCAL shell in the DISTINCT 'signed-out, resume sync' mode rather than a hard login-kick.
        // The at-rest data is already on-device (rely-on-device disclosure), so a hard-401 protects nothing
        // real; sync stays gated by the absent bearer. suspendSync() stops any cycle so the dead session is
        // never loop-retried (local edits queue, drain after a FULL re-login mints a fresh bearer). A
        // non-401 error, or no resident, falls to the login gate as before.
        if (res.status === 401) {
          const resident = await readAccountMarker();
          if (resident) {
            suspendSync();
            set({ isAuthed: true, sessionState: 'revoked', accountId: resident, bearerToken: null, recoveryEstablished: true });
            return;
          }
        }
        set({ isAuthed: false, sessionState: 'unauthed' });
        return;
      }
      const s = (await res.json()) as AccessTokenResponse;
      // #52 tenancy (option B): purge the local store if it belongs to another account (or is unmarked
      // — first fixed-build load). AWAITED BEFORE the shell opens so there's no cold-boot flash of the
      // prior account's notes, and so the list/switcher never read another account's data.
      await ensureAccountScope(s.accountId);
      // A live ceremony owns the gate — don't let a background refresh open the shell underneath it.
      // recoveryEstablished rides the refresh (always true in devSys's impl — a durable cookie only
      // exists post-finalize); the gate routes a false to the forced-phrase screen as a fail-safe belt.
      const opening = get().isAuthing ? {} : { isAuthed: true, sessionState: 'active' as const };
      set({ bearerToken: s.token, accountId: s.accountId, username: s.username, recoveryEstablished: readRecoveryFlag(s), totpEnabled: readTotpFlag(s), ...opening });
    } catch {
      // Network failure on cold boot — NOT a credential failure, so it must NOT kick to login (#85). If a
      // session was established on this device (a resident account marker), OPEN THE SHELL OFFLINE from the
      // local Dexie store: the data layer scopes on accountId, NOT the bearer, so notes render with no
      // credential; API/sync no-op offline and resume on reconnect (no re-login). Only a device with NO
      // resident account falls to the login gate — true first-setup, which can't happen offline anyway.
      if (get().isAuthing) return; // a live ceremony owns the gate
      const resident = await readAccountMarker();
      if (resident) {
        // recoveryEstablished:true so the gate doesn't divert to the recovery screen — a resident finalized
        // account already established it. bearerToken stays null until reconnect re-mints it.
        set({ isAuthed: true, sessionState: 'offline', accountId: resident, bearerToken: null, recoveryEstablished: true });
      } else {
        set({ isAuthed: false, sessionState: 'offline' });
      }
    }
  },

  async remintBearer() {
    let res: Response;
    try {
      res = await authFetch('/refresh', undefined, undefined, REFRESH_TIMEOUT_MS);
    } catch {
      return 'offline'; // network error or timeout — stay offline; the next reconnect/cycle retries
    }
    if (!res.ok) {
      // A genuine 401 = the refresh cookie is revoked/expired → a full re-login is required (#89). Any
      // other non-ok (5xx/transient) → 'offline' so a blip doesn't latch the scary error state.
      return res.status === 401 ? 'revoked' : 'offline';
    }
    const s = (await res.json()) as AccessTokenResponse;
    // Identity must not change under a live session. If the cookie somehow re-points to a DIFFERENT
    // account, never swap the live session into it (that would cross the tenancy boundary with no wipe) —
    // treat it as revoked so the caller forces a clean re-login.
    if (get().accountId && s.accountId !== get().accountId) return 'revoked';
    set({
      bearerToken: s.token,
      recoveryEstablished: readRecoveryFlag(s),
      totpEnabled: readTotpFlag(s),
      sessionState: 'active',
    });
    return 'ok';
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
      // The failure-triggered Turnstile fires as a 403 (challenge_required/challenge_failed) — read the
      // body code to distinguish it from the status-mapped credential errors so the route can render the widget.
      const raw = await res.json().catch(() => ({})) as { error?: { code?: string } };
      if (isChallengeCode(raw.error?.code)) return { ok: false, code: 'challenge' };
      const code = res.status === 409 ? 'username_taken'
        : res.status === 429 ? 'rate_limited'
        : res.status === 400 ? 'weak_password'
        : 'invalid';
      return { ok: false, code };
    }
    const s = (await res.json()) as RegisterResponse;
    // #52 tenancy (option B): a brand-new account on this device — purge any prior account's residue
    // before this account's session begins (marker differs → wipe), so it starts on a clean local store.
    await ensureAccountScope(s.accountId);
    // Session minted — access token only (signup never Set-Cookies; the durable cookie waits for
    // finalize) AND no recovery phrase (Option-B single-hash signup: the verifier isn't hashed here —
    // the phrase is minted by establishRecovery/rotate next, like the forced-phrase flow). The shell
    // stays closed until finalizeAuth; recoveryEstablished is false until then. The route runs
    // beginAuth → register → establishRecovery → [show phrase] → finalizeAuth.
    set({ bearerToken: s.token, accountId: s.accountId, username: s.username, recoveryEstablished: false, totpEnabled: false });
    return { ok: true };
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
      if (isChallengeCode(c)) return { ok: false, code: 'challenge' };
      if (c === 'totp_required') return { ok: false, code: 'totp_required' };
      if (c === 'totp_invalid') return { ok: false, code: 'totp_invalid' };
      return { ok: false, code: 'invalid' }; // uniform — no username enumeration
    }
    const s = (await res.json()) as AccessTokenResponse;
    // #52 tenancy (option B): a login may be a SWITCH to a different account on this device — purge the
    // prior account's local store BEFORE we set the new session, so the shell (which opens via the route
    // after this resolves) never reads the prior account's notes/notebooks and no un-pushed prior-account
    // queue entry can drain under the new bearer (the W8 write-migration leak).
    await ensureAccountScope(s.accountId);
    const recoveryEstablished = readRecoveryFlag(s);
    set({ bearerToken: s.token, accountId: s.accountId, username: s.username, recoveryEstablished, totpEnabled: readTotpFlag(s) });
    // recoveryRequired = the account was created but never finalized a recovery phrase (abandoned
    // signup that set a password). The route forces the phrase screen before entry (the P0-belt);
    // a flag=true login is ungated as normal. flag=false login also defers the cookie to finalize.
    return { ok: true, recoveryRequired: recoveryEstablished === false };
  },

  async logout() {
    // #52 tenancy — LOGOUT does a FULL client-local wipe (security primary), ordered so a re-login is clean:
    // 1. suspendSync(): stop the poll so no NEW cycle starts (and a mid-cycle one skips its re-populating pull).
    suspendSync();
    // 2. #54: GUARANTEE all queued edits flush to the server BEFORE the wipe — not just an in-flight push.
    //    Today an edit queued in the ~2s debounce window at the sign-out instant would be dropped by the wipe;
    //    this drains the whole push queue deterministically (bearer still in memory; runs BEFORE /logout
    //    revokes it). Best-effort: offline / push error → proceed (pre-real-users data is disposable).
    try { await flushPushQueue(); } catch { /* can't reach server — proceed; the local wipe still runs */ }
    // 3. Server logout (revoke all sessions + clear the refresh cookie) — needs the bearer, still in memory.
    try { await authFetch('/logout', undefined, get().bearerToken); } catch { /* clear locally regardless */ }
    // 4. Wipe ALL local account state (Dexie tables + notebook pointer + sync cursors) + drop the marker.
    try { await purgeAllLocalState(); } catch { /* best-effort; never block sign-out on a storage error */ }
    // 5. Clear the in-memory session + close the gate. Net: no bearer, no refresh cookie, no local data,
    //    no resident-account marker → the next login re-detects from a clean slate and re-pulls from seq 0.
    set({ bearerToken: null, accountId: null, username: null, recoveryEstablished: null, totpEnabled: false, isAuthed: false, isAuthing: false, sessionState: 'unauthed' });
  },

  async resetWithPhrase(username, phrase, newPassword, turnstileToken) {
    set({ error: null });
    let res: Response;
    try { res = await authFetch('/reset', { username, recoveryPhrase: phrase, newPassword, ...(turnstileToken ? { turnstileToken } : {}) }); }
    catch { return { ok: false, code: 'network' }; }
    if (!res.ok) {
      if (res.status === 429) return { ok: false, code: 'rate_limited' };
      // The failure-triggered Turnstile (403 challenge_*) is distinct from the uniform 401 reset failure.
      const raw = await res.json().catch(() => ({})) as { error?: { code?: string } };
      if (isChallengeCode(raw.error?.code)) return { ok: false, code: 'challenge' };
      return { ok: false, code: 'invalid' }; // non-disclosing — never confirms the username exists
    }
    const s = (await res.json()) as AccessTokenResponse;
    // A reset re-establishes the password via the phrase the user just proved — the account remains
    // recoverable; the server reports recoveryEstablished on the response (true) and the route enters.
    set({ bearerToken: s.token, accountId: s.accountId, username: s.username, recoveryEstablished: readRecoveryFlag(s) });
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
    // A 2FA change revoke-all'd every session (incl. this device's OLD bearer) and re-issued a fresh one
    // so the acting device stays signed in — swap to the new in-memory access token. Also mirror
    // totpEnabled=1 (server-authoritative) so the Settings toggle reflects "on" without a round-trip.
    const b = (await res.json().catch(() => ({}))) as { token?: string };
    set({ totpEnabled: true, ...(b.token ? { bearerToken: b.token } : {}) });
    return { ok: true };
  },

  async disableTotp(code) {
    // Re-prove with a current code (anti-lockout symmetry with verify). The server treats this as a 2FA
    // credential-change → revoke-all (other devices re-auth) THEN re-issues this device's session
    // (fresh access token in the body + fresh refresh cookie), so the toggling device stays signed in.
    let res: Response;
    try { res = await authFetch('/totp/disable', { code }, get().bearerToken); }
    catch { return { ok: false, code: 'network' }; }
    if (!res.ok) {
      const raw = await res.json().catch(() => ({})) as { error?: { code?: string } };
      if (raw.error?.code === 'totp_not_enabled') return { ok: false, code: 'not_enabled' };
      return { ok: false, code: 'totp_invalid' };
    }
    // Like enable: the server revoke-all'd + re-issued a fresh session so the acting device stays
    // signed in — swap to the new in-memory access token and mirror totpEnabled=0.
    const b = (await res.json().catch(() => ({}))) as { token?: string };
    set({ totpEnabled: false, ...(b.token ? { bearerToken: b.token } : {}) });
    return { ok: true };
  },

  async establishRecovery() {
    // Forced-phrase belt: rotate to a FRESH recovery phrase server-side (the original is gone). The
    // rotate endpoint updates the Argon2id verifier + returns the phrase ONCE; it does NOT set the
    // flag/cookie — those wait for /finalize at save+ack, so recoveryEstablished flips only at ack.
    let res: Response;
    try { res = await authFetch('/recovery/rotate', {}, get().bearerToken); }
    catch { return { ok: false, code: 'network' }; }
    if (!res.ok) return { ok: false, code: 'invalid' };
    const b = (await res.json()) as { recoveryPhrase: string };
    return { ok: true, recoveryPhrase: b.recoveryPhrase };
  },

  beginAuth() { set({ isAuthing: true }); },
  async finalizeAuth() {
    // Cookie-at-finalize: POST /finalize (authed, empty body) sets the durable refresh cookie AND
    // recoveryEstablished=true together — the ceremony-complete moment. Only on its success do we open
    // the shell; a failure stays on the screen (no cookie-less, flag-false session leaks into the app).
    let res: Response;
    try { res = await authFetch('/finalize', {}, get().bearerToken); }
    catch { return { ok: false, code: 'network' }; }
    // secSys guard: 409 = no recovery verifier established yet (rotate must precede finalize). The
    // happy + forced paths always establishRecovery first, so this never fires there — surfaced anyway.
    if (res.status === 409) return { ok: false, code: 'recovery_not_established' };
    if (!res.ok) return { ok: false, code: 'invalid' };
    set({ isAuthing: false, isAuthed: true, recoveryEstablished: true, sessionState: 'active' });
    return { ok: true };
  },
  clearError() { set({ error: null }); },
}));
