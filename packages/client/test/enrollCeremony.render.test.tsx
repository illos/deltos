/**
 * ENROLL COMPLETES E2E — permanent done-gate invariant (jsdom).
 *
 * Regression gate for the P0 "enrolling latch": the boot gate switched to the shell the instant
 * isEnrolled flipped, which used to be set at the PASSKEY step — unmounting EnrollRoute mid-ceremony
 * so the recovery phrase was never shown and register()/mintSession() never ran (sync then 503'd).
 * This false-greened past both the unit suite (no full-ceremony test) and the dogfood (pill masked
 * it). This test drives the WHOLE ceremony through the real <App/> router + real EnrollRoute/store/
 * gate, asserting:
 *   1. the recovery phrase RENDERS after the passkey step (EnrollRoute is NOT unmounted),
 *   2. POST /api/auth/register AND POST /api/auth/session are called and the flow advances
 *      (a non-200 would divert to the error screen, never to the username step),
 *   3. on completion (finalizeEnroll) the shell takes over and a REAL sync round-trip fires,
 *      carrying the in-memory bearer token (authenticated — NOT the unverified 503).
 *
 * The keyStore singleton is stubbed (no real WebAuthn) and fetch is canned 200s — this is the
 * flow-wiring gate, not the crypto (register.test.ts / session.test.ts cover the real signatures).
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { base64urlEncode } from '@deltos/shared';
import { App } from '../src/App.js';
import { screen, userEvent, waitFor } from './renderHelpers.js';

// ── Stub the WebAuthn KeyStore singleton (no real navigator.credentials). Built inside vi.hoisted so
// the hoisted vi.mock factory can reference it without a TDZ error. ──────────────────────────────
const h = vi.hoisted(() => {
  let unlocked = false;
  const MNEMONIC =
    'abandon ability able about above absent absorb abstract absurd abuse access accident ' +
    'account accuse achieve acid acoustic acquire across act action actor actress actual';
  const keyStoreStub = {
    isEnrolled: () => Promise.resolve(false),
    enrollNew: async () => { unlocked = true; return { identity: { id: 'test-id' }, mnemonic: MNEMONIC }; },
    enrollExisting: () => Promise.reject(new Error('not used in this test')),
    unlock: async () => ({ id: 'test-id' }),
    lock: () => { unlocked = false; },
    isUnlocked: () => unlocked,
    currentIdentity: () => (unlocked ? { id: 'test-id' } : null),
    autoUnlock: async () => null,
    sign: async () => new Uint8Array(64).fill(0xfe),
    getSigningPublicKey: () => new Uint8Array(32).fill(0x11),
    setServerKeyId: async () => {},
    getServerKeyId: async () => null,
  };
  return { keyStoreStub, resetUnlocked: () => { unlocked = false; } };
});

vi.mock('../src/auth/keyStoreInstance.js', () => ({ keyStore: h.keyStoreStub }));

// ── Canned server: a non-expired challenge + 200s for register/session/sync ──────────────────────
const CHALLENGE = {
  challengeId: base64urlEncode(new Uint8Array(32).fill(0xdd)),
  nonce: base64urlEncode(new Uint8Array(32).fill(0xcc)),
  expiresAt: '2099-01-01T00:00:00.000Z',
  expiresAtMs: 4102444800000,
};
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status });

beforeEach(async () => {
  h.resetUnlocked();
  const { useAuthStore } = await import('../src/auth/store.js');
  useAuthStore.setState({ isEnrolled: null, isUnlocked: false, keyId: null, bearerToken: null, accountId: null, sessionState: 'booting', identity: null });
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();

  global.fetch = vi.fn(async (url: string | URL, opts?: RequestInit) => {
    const u = String(url);
    if (u.includes('/auth/challenge')) return json(CHALLENGE);
    if (u.includes('/auth/register')) return json({ keyId: 'kid-1', accountFingerprint: 'fp-1' });
    if (u.includes('/auth/session')) return json({ token: 'tok-1', expiresAt: '2099-01-01T00:00:00.000Z', accountId: 'acct-1' });
    if (u.includes('/sync/push')) return json({ results: [] });
    if (u.includes('/sync/pull')) return json({ notes: [], nextCursor: 0, hasMore: false });
    void opts;
    return json({}, 404);
  }) as typeof fetch;
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function fetchedUrls(): string[] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
}

describe('enroll completes e2e (P0 enrolling-latch gate)', () => {
  it('phrase renders → register + session 200 → shell + authenticated sync round-trip', async () => {
    const user = userEvent.setup();
    render(<App />);

    // App boots; the unenrolled `*` route redirects to /enroll. Welcome appears.
    await screen.findByRole('button', { name: /set up with passkey/i });
    await user.click(screen.getByRole('button', { name: /set up with passkey/i }));

    // (1) REGRESSION CORE: the recovery-phrase screen RENDERS (EnrollRoute not unmounted by the gate).
    await screen.findByText(/save your recovery phrase/i);
    expect(screen.getByText('abandon')).toBeDefined(); // a mnemonic word actually rendered

    // (2) Advance: check the "written it down" box, Continue → register() + mintSession().
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    // Reaching the username step PROVES register + session both 200'd (a non-200 → error screen).
    await screen.findByText(/choose a handle/i);
    expect(fetchedUrls().some((u) => u.includes('/auth/register'))).toBe(true);
    expect(fetchedUrls().some((u) => u.includes('/auth/session'))).toBe(true);

    // (3) Finalize (Skip) → finalizeEnroll flips isEnrolled → the shell takes over.
    await user.click(screen.getByRole('button', { name: /skip for now/i }));
    await screen.findByText(/δ deltos/i); // shell header mark

    // A REAL sync round-trip fires, carrying the in-memory bearer token (authenticated, NOT a 503).
    await waitFor(() => expect(fetchedUrls().some((u) => u.includes('/sync/'))).toBe(true));
    const syncCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).includes('/sync/'));
    const headers = (syncCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-1');
  });
});
