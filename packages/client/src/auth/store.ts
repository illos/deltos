/**
 * Zustand auth store — single source of truth for the app's auth state.
 *
 * keyId is persisted to localStorage AND durably in IndexedDB (KeyStore.setServerKeyId, the E4
 * durability fix @2d629a6) so a cold-start session re-mint survives iOS localStorage eviction.
 * bearerToken, identity, and sessionState are in-memory ONLY (lost on refresh — F7 HARD GATE: the
 * session token has no at-rest home anywhere, ever).
 *
 * ── Local-first shell (v1 course-correction, spec Part 1a) ──────────────────────────────────────
 * Auth is a BACKGROUND concern, never a boot gate. `init()` reads the LOCAL durable identity
 * (isEnrolled + keyId from IndexedDB — no network) so the shell can render notes from the local
 * store immediately; it then kicks `establishSession()` to (re-)mint a session in the background.
 * `sessionState` is a QUIET status the shell surfaces non-blockingly — it never gates the notes UI.
 * The ONLY blocking auth screen is the first-run / cleared-data enroll path (App.tsx gates on
 * `!isEnrolled`, not on session state).
 *
 * secSys HARD LINE (Part 1a custody constraint): the render path must NEVER unwrap the signing key.
 * Notes render from plaintext local Dexie; the key unwrap happens ONLY inside the background re-auth
 * (`establishSession` → only when the KeyStore is already unlocked), never on first paint.
 *
 * PIN-ID-9 contract (WebAuthn transient activation):
 *   The enroll / enrollExisting / unlock actions are called DIRECTLY from button onClick
 *   handlers with no preceding async work. Each immediately delegates to the KeyStore which
 *   calls WebAuthn create()/get() as its FIRST await — within the gesture's activation window.
 *   Do NOT insert any await (network call, state check) before the KeyStore call in a gesture
 *   handler, or iOS Safari will reject the WebAuthn ceremony with NotAllowedError.
 */
import { create } from 'zustand';
import { SCOPES } from '@deltos/shared';
import { keyStore } from './keyStoreInstance.js';
import { buildRegisterRequest } from '../identity/register.js';
import { buildSessionRequest } from '../identity/session.js';
import { getEnrollmentPrfStatus } from '../identity/webAuthnKeyStore.js';
import type { Identity } from '../identity/keyStore.js';

const KEY_ID_STORAGE_KEY = 'deltos:keyId';

function getStoredKeyId(): string | null {
  try { return localStorage.getItem(KEY_ID_STORAGE_KEY); } catch { return null; }
}
function storeKeyId(id: string): void {
  try { localStorage.setItem(KEY_ID_STORAGE_KEY, id); } catch { /* ignore */ }
}

/**
 * Quiet, in-memory background-session status. NEVER gates the notes UI (the shell renders from the
 * local store regardless); the shell surfaces it non-blockingly (SessionStatus nudge).
 *  - `booting`       — initial; the local durable-identity read has not resolved yet.
 *  - `establishing`  — background signed-challenge re-auth in flight (key already in memory).
 *  - `active`        — a live in-memory bearer token; sync can flow.
 *  - `needs-unlock`  — re-auth needs a user gesture to unwrap the key (Part 1a; Part 1b's Option-A
 *                      autoUnlock makes this silent). Surfaced as a tappable nudge, never a gate.
 *  - `offline`       — the mint failed on the network; retried with backoff. No eviction to recovery.
 */
export type SessionState = 'booting' | 'establishing' | 'active' | 'needs-unlock' | 'offline';

// --- Background re-auth retry (backoff) -------------------------------------------------------
// Only the NETWORK-failure path retries (sessionState 'offline'): the key is already in memory, so a
// later attempt can succeed once connectivity returns. The 'needs-unlock' path does NOT retry — it
// needs a user gesture, surfaced as a nudge. F7 is unaffected: nothing here touches the token at rest.
const REAUTH_BACKOFF_START_MS = 2_000;
const REAUTH_BACKOFF_MAX_MS = 30_000;
let _reauthTimer: ReturnType<typeof setTimeout> | null = null;
let _reauthBackoffMs = REAUTH_BACKOFF_START_MS;

function scheduleReauth(run: () => void): void {
  if (_reauthTimer) return; // a retry is already pending
  const delay = _reauthBackoffMs;
  _reauthBackoffMs = Math.min(_reauthBackoffMs * 2, REAUTH_BACKOFF_MAX_MS);
  _reauthTimer = setTimeout(() => { _reauthTimer = null; run(); }, delay);
}

function resetReauthBackoff(): void {
  _reauthBackoffMs = REAUTH_BACKOFF_START_MS;
  if (_reauthTimer) { clearTimeout(_reauthTimer); _reauthTimer = null; }
}

/** A fetch transport failure (offline / server unreachable) vs an HTTP error response. */
function isFetchTransportError(e: unknown): boolean {
  return e instanceof TypeError && /fetch/i.test(e.message);
}

export type ClaimUsernameResult =
  | { ok: true; username: string }
  | { ok: false; code: 'name-taken' | 'account-has-username' | 'invalid' | 'not-authed' | 'network' };

export interface AuthState {
  /** null = not yet checked (initial loading). false = not enrolled. true = enrolled. */
  isEnrolled: boolean | null;
  isUnlocked: boolean;
  identity: Identity | null;
  /** Server-issued device handle, persisted to localStorage. null = not registered yet. */
  keyId: string | null;
  /** In-memory bearer token (lost on refresh). null = no active session. */
  bearerToken: string | null;
  /** Stable credential-independent account key from session response. Local note tagging only — never sent to server on writes. */
  accountId: string | null;
  /** null = unknown; true = PRF bound; false = device-local (D5 disclosure required). */
  usesPrf: boolean | null;
  /** Quiet background-session status (see {@link SessionState}). Never gates the notes UI. */
  sessionState: SessionState;
  /**
   * True for exactly one unlock: an already-PRF-enrolled device just silently downgraded to
   * device-local custody via the Option-A rewrap-on-next-unlock migration. Drives the one-time
   * device-local notice at the migration unlock (secSys honesty-of-record finding; planSys ruled
   * SHOW ONCE). Cleared by {@link clearMigrationNotice} once shown.
   */
  justMigratedToDeviceLocal: boolean;
  error: string | null;
}

interface AuthActions {
  /**
   * Read the LOCAL durable identity (isEnrolled + keyId from IndexedDB — no network) and populate
   * the gate inputs, then kick {@link establishSession} in the BACKGROUND. Resolves as soon as the
   * local read is done — it NEVER awaits the session mint, so the shell renders before any auth
   * round-trip (render-before-data). Call once at app boot.
   */
  init(): Promise<void>;

  /**
   * Background signed-challenge re-auth from the stored key. NON-BLOCKING and NON-THROWING: on
   * success → sessionState 'active' + an in-memory token; with no key in memory / no keyId →
   * 'needs-unlock' (a quiet nudge, never a gate); on network failure → 'offline' + backoff retry
   * (no eviction to a recovery screen).
   *
   * secSys Part-1a custody line: this is the ONLY place the signing key is used — and only when the
   * KeyStore is ALREADY unlocked. It never unwraps the key, and is never on the first-paint path.
   */
  establishSession(): Promise<void>;

  /**
   * Enroll a new identity on this device (brand-new account).
   * Returns the mnemonic (ONCE — the only time it leaves the custody boundary) and the
   * PRF binding status (for D5 disclosure rendering).
   *
   * MUST be called directly from a button onClick — no preceding awaits (PIN-ID-9).
   */
  enroll(): Promise<{ mnemonic: string; usesPrf: boolean }>;

  /**
   * Re-bind an existing identity to this device via a known mnemonic (recovery or QR-join).
   *
   * MUST be called directly from a button onClick — no preceding awaits (PIN-ID-9).
   */
  enrollExisting(mnemonic: string): Promise<{ usesPrf: boolean }>;

  /**
   * Unlock using the stored passkey (WebAuthn get()). Returns 'ok' or 'cancelled'.
   *
   * MUST be called directly from a button onClick — no preceding awaits (PIN-ID-9).
   */
  unlock(): Promise<'ok' | 'cancelled'>;

  /**
   * Register this device with the server after a successful local enroll*.
   * Stores the returned keyId in localStorage for future unlock → session flows.
   * deviceLabel is auto-detected from the user agent; UI may let the user customise it.
   */
  register(deviceLabel: string): Promise<void>;

  /**
   * Mint a bearer session token by signing a server-issued challenge.
   * The token is stored in-memory (bearerToken). Requires isUnlocked + keyId.
   */
  mintSession(): Promise<void>;

  /**
   * Claim a username for this account via POST /api/auth/username.
   * F-acct-4: availability is revealed ONLY through this authenticated claim, never an oracle.
   */
  claimUsername(username: string): Promise<ClaimUsernameResult>;

  lock(): void;
  clearError(): void;
  /** Dismiss the one-time device-local migration notice (after it has been shown once). */
  clearMigrationNotice(): void;
}

export const useAuthStore = create<AuthState & AuthActions>((set, get) => ({
  isEnrolled: null,
  isUnlocked: false,
  identity: null,
  keyId: getStoredKeyId(),
  bearerToken: null,
  accountId: null,
  usesPrf: null,
  sessionState: 'booting',
  justMigratedToDeviceLocal: false,
  error: null,

  async init() {
    try {
      // LOCAL durable reads only — no network. These decide the boot gate (enroll vs shell) and
      // tell the app whose notes to show, so the shell can paint before any auth round-trip.
      const enrolled = await keyStore.isEnrolled();
      // Resolve keyId: localStorage fast-read first; fall back to durable IDB on eviction.
      let keyId = getStoredKeyId();
      let usesPrf: boolean | null = null;
      if (enrolled) {
        const prfStatus = await getEnrollmentPrfStatus();
        usesPrf = prfStatus?.usesPrf ?? null;
        if (!keyId) {
          const idbKeyId = await keyStore.getServerKeyId();
          if (idbKeyId) {
            keyId = idbKeyId;
            storeKeyId(idbKeyId); // mirror back to localStorage for next fast-path read
          }
        }
      }
      set({ isEnrolled: enrolled, keyId, usesPrf });
      // Background re-auth — deliberately NOT awaited: the shell renders from the local store now,
      // and the session is established underneath it. A failure here never blocks or evicts.
      if (enrolled) void get().establishSession();
    } catch (e) {
      set({ isEnrolled: false, error: String(e) });
    }
  },

  async establishSession() {
    const { isEnrolled, keyId, bearerToken } = get();
    if (!isEnrolled) return;                       // no local identity — the enroll gate handles this
    if (bearerToken) { set({ sessionState: 'active' }); return; } // already authed this session

    // No registered device handle → the gesture path (UnlockRoute) re-registers; quiet nudge.
    if (!keyId) {
      set({ sessionState: 'needs-unlock' });
      return;
    }

    // Part 1b (Option-A): SILENTLY unwrap the device-local key with NO gesture, in the background
    // (after first paint — never on the render path). A device-local blob unlocks silently; a
    // not-yet-migrated PRF blob returns null → graceful-degrade to the gesture nudge (which migrates
    // it on the next unlock). This is the zero-day-to-day-friction path (the north star).
    if (!keyStore.isUnlocked()) {
      const identity = await keyStore.autoUnlock();
      if (!identity) {
        set({ sessionState: 'needs-unlock' });
        return;
      }
      set({ isUnlocked: true, identity });
    }

    set({ sessionState: 'establishing' });
    try {
      await get().mintSession();                   // sets bearerToken + accountId + sessionState 'active'
      resetReauthBackoff();
    } catch (e) {
      if (isFetchTransportError(e)) {
        // Offline / server down — keep working locally and retry with backoff. No recovery screen.
        set({ sessionState: 'offline' });
        scheduleReauth(() => void get().establishSession());
      } else {
        // HTTP-level rejection (e.g. the device was revoked server-side) — fall back to the gesture
        // path, still non-blocking.
        set({ sessionState: 'needs-unlock' });
      }
    }
  },

  async enroll() {
    set({ error: null });
    const result = await keyStore.enrollNew(); // WebAuthn create() is the FIRST await (PIN-ID-9)
    const prfStatus = await getEnrollmentPrfStatus();
    const usesPrf = prfStatus?.usesPrf ?? false;
    set({ isEnrolled: true, isUnlocked: true, identity: result.identity, usesPrf });
    return { mnemonic: result.mnemonic, usesPrf };
  },

  async enrollExisting(mnemonic: string) {
    set({ error: null });
    const identity = await keyStore.enrollExisting(mnemonic); // WebAuthn create() first await (PIN-ID-9)
    const prfStatus = await getEnrollmentPrfStatus();
    const usesPrf = prfStatus?.usesPrf ?? false;
    set({ isEnrolled: true, isUnlocked: true, identity, usesPrf });
    return { usesPrf };
  },

  async unlock() {
    set({ error: null });
    const wasPrf = get().usesPrf; // disclosed custody BEFORE this unlock (true = PRF-bound)
    const identity = await keyStore.unlock(); // WebAuthn get() first await (PIN-ID-9); may rewrap-migrate
    if (!identity) return 'cancelled';
    const prfStatus = await getEnrollmentPrfStatus();
    const usesPrf = prfStatus?.usesPrf ?? null;
    // Option-A migration just happened iff the device WAS PRF-bound and is NOW device-local — the
    // unlock() rewrap flipped prf→false. Surface the one-time device-local notice (planSys: show once).
    set({ isUnlocked: true, identity, usesPrf, justMigratedToDeviceLocal: wasPrf === true && usesPrf === false });
    return 'ok';
  },

  async register(deviceLabel: string) {
    const req = await buildRegisterRequest({ keyStore, deviceLabel });
    const resp = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!resp.ok) {
      const raw = await resp.json().catch(() => ({})) as Record<string, unknown>;
      const msg = (raw.error as { message?: string } | undefined)?.message
        ?? `registration failed: HTTP ${resp.status}`;
      throw new Error(msg);
    }
    const { keyId } = (await resp.json()) as { keyId: string; accountFingerprint: string };
    await keyStore.setServerKeyId(keyId); // durable IDB storage (survives iOS localStorage eviction)
    storeKeyId(keyId);                    // localStorage mirror (fast cold-start read)
    set({ keyId });
  },

  async mintSession() {
    const { keyId } = get();
    if (!keyId) throw new Error('no keyId — register this device first');
    const req = await buildSessionRequest({
      keyStore,
      keyId,
      requestedScope: [...SCOPES], // request all scopes; server clamps via F5
    });
    const resp = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!resp.ok) {
      const raw = await resp.json().catch(() => ({})) as Record<string, unknown>;
      const msg = (raw.error as { message?: string } | undefined)?.message
        ?? `session mint failed: HTTP ${resp.status}`;
      throw new Error(msg);
    }
    const { token, accountId } = (await resp.json()) as { token: string; expiresAt: string; accountId: string };
    // F7: the token lives ONLY here, in memory. It is never written to localStorage / Dexie / cache.
    set({ bearerToken: token, accountId, sessionState: 'active' });
  },

  async claimUsername(username: string): Promise<ClaimUsernameResult> {
    const { bearerToken } = get();
    if (!bearerToken) return { ok: false, code: 'not-authed' };
    const resp = await fetch('/api/auth/username', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ username }),
    });
    if (resp.status === 201 || resp.status === 200) {
      const body = await resp.json() as { username: string };
      return { ok: true, username: body.username };
    }
    const raw = await resp.json().catch(() => ({ error: { code: 'unknown' } })) as {
      error?: { code?: string };
    };
    const code = raw.error?.code ?? 'unknown';
    if (resp.status === 409 && code === 'username_exists') {
      return { ok: false, code: 'account-has-username' };
    }
    if (resp.status === 409) return { ok: false, code: 'name-taken' };
    if (resp.status === 400) return { ok: false, code: 'invalid' };
    return { ok: false, code: 'network' };
  },

  lock() {
    keyStore.lock();
    resetReauthBackoff();
    set({ isUnlocked: false, identity: null, bearerToken: null, accountId: null, usesPrf: null, sessionState: 'needs-unlock' });
  },

  clearError() { set({ error: null }); },

  clearMigrationNotice() { set({ justMigratedToDeviceLocal: false }); },
}));

// Background re-auth recovery: when connectivity returns, retry the session mint for an enrolled
// device that has no live token yet (the key must already be in memory — establishSession enforces
// that and falls back to a quiet nudge otherwise). Guarded so it is a no-op in non-browser (test) envs.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    const s = useAuthStore.getState();
    if (s.isEnrolled && !s.bearerToken) void s.establishSession();
  });
}

/** Detect a plausible device label from the browser UA (for the registration deviceLabel field). */
export function detectDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows NT/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux';
  return 'My Device';
}
