/**
 * Background-session seam — establishSession state machine + render-before-data + F7 (acceptance
 * matrix P1-1, P1-3, P1-4, P1-9).
 *
 * These exercise the AUTH-store logic that drives the local-first shell, in the node env (no DOM):
 *   - P1-1  render-before-data — init() resolves WITHOUT awaiting the session mint (the mint can hang
 *           forever and the launch decision still completes).
 *   - P1-3  silent background re-auth — with the key already in memory + a stored keyId, the session
 *           is minted from the stored key with no further user action.
 *   - P1-4  failure stays non-blocking — a network failure → sessionState 'offline', no throw, no
 *           eviction (isEnrolled stays true); a key not in memory → a quiet 'needs-unlock' nudge.
 *   - P1-9  F7 — a minted token is NEVER written to localStorage.
 *
 * keyStore / identity builders are mocked so the seam's branching is tested in isolation from crypto.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- localStorage shim (node env has none) — also the F7 assertion surface -----------------------
const lsBacking = new Map<string, string>();
const fakeLocalStorage = {
  getItem: vi.fn((k: string) => (lsBacking.has(k) ? lsBacking.get(k)! : null)),
  setItem: vi.fn((k: string, v: string) => { lsBacking.set(k, v); }),
  removeItem: vi.fn((k: string) => { lsBacking.delete(k); }),
  clear: vi.fn(() => { lsBacking.clear(); }),
};
// @ts-expect-error — minimal Storage shim for the store's getStoredKeyId/storeKeyId.
globalThis.localStorage = fakeLocalStorage;

// --- mocked dependencies (hoisted so vi.mock factories can reference them) ------------------------
const mocks = vi.hoisted(() => ({
  keyStore: {
    isEnrolled: vi.fn(),
    isUnlocked: vi.fn(),
    autoUnlock: vi.fn(),
    getServerKeyId: vi.fn(),
    setServerKeyId: vi.fn(),
    lock: vi.fn(),
    enrollNew: vi.fn(),
    enrollExisting: vi.fn(),
    unlock: vi.fn(),
    currentIdentity: vi.fn(),
    sign: vi.fn(),
    getSigningPublicKey: vi.fn(),
  },
  getEnrollmentPrfStatus: vi.fn(),
  buildSessionRequest: vi.fn(),
  buildRegisterRequest: vi.fn(),
}));

vi.mock('../src/auth/keyStoreInstance.js', () => ({ keyStore: mocks.keyStore }));
vi.mock('../src/identity/webAuthnKeyStore.js', () => ({ getEnrollmentPrfStatus: mocks.getEnrollmentPrfStatus }));
vi.mock('../src/identity/session.js', () => ({ buildSessionRequest: mocks.buildSessionRequest }));
vi.mock('../src/identity/register.js', () => ({ buildRegisterRequest: mocks.buildRegisterRequest }));

const fetchMock = vi.fn();

/** Re-import the store fresh so each test starts from the initial zustand state. */
async function freshStore() {
  vi.resetModules();
  const mod = await import('../src/auth/store.js');
  return mod.useAuthStore;
}

function okSession() {
  return {
    ok: true,
    json: async () => ({ token: 'tok-secret-1', expiresAt: '2026-07-16T00:00:00.000Z', accountId: 'acc-1' }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  lsBacking.clear();
  // @ts-expect-error — node has no fetch by default; install the mock.
  globalThis.fetch = fetchMock;
  mocks.getEnrollmentPrfStatus.mockResolvedValue({ usesPrf: false });
  mocks.buildSessionRequest.mockResolvedValue({ keyId: 'k1', signature: 'sig', payload: 'p' });
  mocks.keyStore.autoUnlock.mockResolvedValue(null); // default: silent unwrap unavailable
});

describe('establishSession — background re-auth state machine (P1-3, P1-4)', () => {
  it('key in memory + stored keyId + mint OK → active session, token held in memory', async () => {
    const useAuthStore = await freshStore();
    mocks.keyStore.isUnlocked.mockReturnValue(true);
    fetchMock.mockResolvedValue(okSession());
    useAuthStore.setState({ isEnrolled: true, keyId: 'k1' });

    await useAuthStore.getState().establishSession();

    const s = useAuthStore.getState();
    expect(s.sessionState).toBe('active');
    expect(s.bearerToken).toBe('tok-secret-1');
    expect(s.accountId).toBe('acc-1');
  });

  it('key not in memory + silent autoUnlock succeeds → active, NO gesture (Part 1b north star)', async () => {
    const useAuthStore = await freshStore();
    mocks.keyStore.isUnlocked.mockReturnValue(false);
    mocks.keyStore.autoUnlock.mockResolvedValue({ id: 'acct-id' }); // device-local silent unwrap
    fetchMock.mockResolvedValue(okSession());
    useAuthStore.setState({ isEnrolled: true, keyId: 'k1' });

    await useAuthStore.getState().establishSession();

    const s = useAuthStore.getState();
    expect(mocks.keyStore.autoUnlock).toHaveBeenCalled();
    expect(s.isUnlocked).toBe(true);
    expect(s.sessionState).toBe('active');
    expect(s.bearerToken).toBe('tok-secret-1');
  });

  it('key not in memory + autoUnlock null (un-migrated PRF / no device key) → needs-unlock, no mint', async () => {
    const useAuthStore = await freshStore();
    mocks.keyStore.isUnlocked.mockReturnValue(false);
    mocks.keyStore.autoUnlock.mockResolvedValue(null);
    useAuthStore.setState({ isEnrolled: true, keyId: 'k1' });

    await useAuthStore.getState().establishSession();

    expect(useAuthStore.getState().sessionState).toBe('needs-unlock'); // graceful degrade to gesture
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no stored keyId (never registered) → needs-unlock, no mint attempted', async () => {
    const useAuthStore = await freshStore();
    mocks.keyStore.isUnlocked.mockReturnValue(true);
    useAuthStore.setState({ isEnrolled: true, keyId: null });

    await useAuthStore.getState().establishSession();

    expect(useAuthStore.getState().sessionState).toBe('needs-unlock');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('network failure → offline, no throw, no eviction (isEnrolled stays true) (P1-4)', async () => {
    const useAuthStore = await freshStore();
    mocks.keyStore.isUnlocked.mockReturnValue(true);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    useAuthStore.setState({ isEnrolled: true, keyId: 'k1' });

    await expect(useAuthStore.getState().establishSession()).resolves.toBeUndefined();

    const s = useAuthStore.getState();
    expect(s.sessionState).toBe('offline');
    expect(s.bearerToken).toBeNull();
    expect(s.isEnrolled).toBe(true); // never evicted to a recovery screen
  });

  it('HTTP rejection (e.g. revoked device) → needs-unlock fallback, still non-blocking', async () => {
    const useAuthStore = await freshStore();
    mocks.keyStore.isUnlocked.mockReturnValue(true);
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: 'revoked' } }) });
    useAuthStore.setState({ isEnrolled: true, keyId: 'k1' });

    await useAuthStore.getState().establishSession();

    expect(useAuthStore.getState().sessionState).toBe('needs-unlock');
  });
});

describe('init — render-before-data: the launch decision never awaits the network (P1-1)', () => {
  it('resolves with isEnrolled set even while the session mint hangs forever', async () => {
    const useAuthStore = await freshStore();
    mocks.keyStore.isEnrolled.mockResolvedValue(true);
    mocks.keyStore.getServerKeyId.mockResolvedValue('k1');
    mocks.keyStore.isUnlocked.mockReturnValue(true);
    fetchMock.mockReturnValue(new Promise(() => { /* never resolves — server hung */ }));

    await useAuthStore.getState().init(); // must resolve regardless of the hung mint

    const s = useAuthStore.getState();
    expect(s.isEnrolled).toBe(true);     // the shell can render now
    expect(s.keyId).toBe('k1');          // durable identity read populated the gate inputs
    expect(s.bearerToken).toBeNull();    // session NOT yet established — it runs in the background
  });

  it('not enrolled → no background session kicked (the enroll gate handles it)', async () => {
    const useAuthStore = await freshStore();
    mocks.keyStore.isEnrolled.mockResolvedValue(false);

    await useAuthStore.getState().init();

    expect(useAuthStore.getState().isEnrolled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('unlock — Option-A migration notice (planSys: show once)', () => {
  it('PRF→device-local downgrade on this unlock → justMigratedToDeviceLocal true', async () => {
    const useAuthStore = await freshStore();
    mocks.keyStore.unlock.mockResolvedValue({ id: 'acct-id' });
    mocks.getEnrollmentPrfStatus.mockResolvedValue({ usesPrf: false }); // post-unlock = device-local
    useAuthStore.setState({ usesPrf: true }); // pre-unlock disclosed custody = PRF

    const result = await useAuthStore.getState().unlock();

    expect(result).toBe('ok');
    expect(useAuthStore.getState().justMigratedToDeviceLocal).toBe(true);
  });

  it('already device-local (no downgrade) → no migration notice', async () => {
    const useAuthStore = await freshStore();
    mocks.keyStore.unlock.mockResolvedValue({ id: 'acct-id' });
    mocks.getEnrollmentPrfStatus.mockResolvedValue({ usesPrf: false });
    useAuthStore.setState({ usesPrf: false }); // was already device-local

    await useAuthStore.getState().unlock();

    expect(useAuthStore.getState().justMigratedToDeviceLocal).toBe(false);
  });

  it('cancelled unlock → no migration notice', async () => {
    const useAuthStore = await freshStore();
    mocks.keyStore.unlock.mockResolvedValue(null); // user dismissed the passkey prompt
    useAuthStore.setState({ usesPrf: true });

    const result = await useAuthStore.getState().unlock();

    expect(result).toBe('cancelled');
    expect(useAuthStore.getState().justMigratedToDeviceLocal).toBe(false);
  });

  it('clearMigrationNotice() dismisses the one-time notice', async () => {
    const useAuthStore = await freshStore();
    useAuthStore.setState({ justMigratedToDeviceLocal: true });
    useAuthStore.getState().clearMigrationNotice();
    expect(useAuthStore.getState().justMigratedToDeviceLocal).toBe(false);
  });
});

describe('F7 — session token is in-memory only (P1-9)', () => {
  it('a minted token is never written to localStorage', async () => {
    const useAuthStore = await freshStore();
    mocks.keyStore.isUnlocked.mockReturnValue(true);
    fetchMock.mockResolvedValue(okSession());
    useAuthStore.setState({ isEnrolled: true, keyId: 'k1' });

    await useAuthStore.getState().establishSession();
    expect(useAuthStore.getState().bearerToken).toBe('tok-secret-1'); // present in memory

    // No localStorage write carried the token value, at any key.
    for (const [, value] of fakeLocalStorage.setItem.mock.calls) {
      expect(value).not.toContain('tok-secret-1');
    }
    expect([...lsBacking.values()]).not.toContain('tok-secret-1');
  });
});
