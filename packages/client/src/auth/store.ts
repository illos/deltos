/**
 * Zustand auth store — single source of truth for the app's auth state.
 *
 * keyId is persisted to localStorage so unlock → mintSession works on refresh.
 * bearerToken and identity are in-memory only (lost on refresh → unlock required).
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
  error: string | null;
}

interface AuthActions {
  /** Check isEnrolled() and populate isEnrolled state. Call once at app boot. */
  init(): Promise<void>;

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
}

export const useAuthStore = create<AuthState & AuthActions>((set, get) => ({
  isEnrolled: null,
  isUnlocked: false,
  identity: null,
  keyId: getStoredKeyId(),
  bearerToken: null,
  accountId: null,
  usesPrf: null,
  error: null,

  async init() {
    try {
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
    } catch (e) {
      set({ isEnrolled: false, error: String(e) });
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
    const identity = await keyStore.unlock(); // WebAuthn get() first await (PIN-ID-9)
    if (!identity) return 'cancelled';
    const prfStatus = await getEnrollmentPrfStatus();
    set({ isUnlocked: true, identity, usesPrf: prfStatus?.usesPrf ?? null });
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
    set({ bearerToken: token, accountId });
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
    set({ isUnlocked: false, identity: null, bearerToken: null, accountId: null, usesPrf: null });
  },

  clearError() { set({ error: null }); },
}));

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
