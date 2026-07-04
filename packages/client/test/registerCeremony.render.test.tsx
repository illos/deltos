/**
 * REGISTER COMPLETES E2E — permanent done-gate invariant (jsdom).
 *
 * Regression gate for the P0 "ceremony latch": the boot gate must NOT flip to the shell until
 * finalizeAuth() runs. This is the auth-pivot analogue of the old enrollCeremony gate.
 *
 * The P0 bug class: if isAuthed were to flip before isAuthing clears (e.g. a background
 * refresh racing the ceremony), the gate would unmount RegisterRoute mid-ceremony — the user
 * would never acknowledge the recovery phrase. The fix is finalizeAuth() atomically writing both
 * (isAuthing=false, isAuthed=true) in one Zustand update, and init() respecting isAuthing.
 *
 * This test renders the REAL <App /> router + gate, with mocked store actions that faithfully
 * simulate the state transitions, and asserts:
 *   1. The recovery phrase RENDERS after register() ok (RegisterRoute not unmounted by the gate).
 *   2. .shell is absent at the phrase step (isAuthing pin holds the gate on the auth route).
 *   3. On Skip (finalizeAuth) the shell takes over — gate opens exactly at ceremony-complete.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { App } from '../src/App.js';
import { screen, userEvent } from './renderHelpers.js';
import { useAuthStore } from '../src/auth/store.js';

const SAMPLE_PHRASE =
  'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 ' +
  'word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24';

beforeEach(async () => {
  window.history.pushState({}, '', '/register');

  // Mocked actions update the shared Zustand store so the gate / selectBootView see the
  // correct state transitions — same guarantees as the real actions, no network needed.
  useAuthStore.setState({
    isAuthed: null,
    isAuthing: false,
    bearerToken: null,
    accountId: null,
    username: null,
    recoveryEstablished: null,
    sessionState: 'booting',
    error: null,
    // init: simulate cold boot with no session → isAuthed=false
    init: vi.fn(async () => {
      useAuthStore.setState({ isAuthed: false, sessionState: 'unauthed' });
    }),
    // P0 latch actions — same semantics as the real implementation
    beginAuth: vi.fn(() => { useAuthStore.setState({ isAuthing: true }); }),
    finalizeAuth: vi.fn(async () => {
      useAuthStore.setState({ isAuthed: true, isAuthing: false, sessionState: 'active', recoveryEstablished: true });
      return { ok: true } as const;
    }),
    // register: signup succeeds + mints the session (Option-B single-hash: NO phrase on this result)
    register: vi.fn(async () => ({ ok: true } as const)),
    // establishRecovery: the happy-path phrase source now (via /recovery/rotate), same as forced-phrase
    establishRecovery: vi.fn(async () => ({ ok: true, recoveryPhrase: SAMPLE_PHRASE } as const)),
    // other auth actions: stubs (not exercised in the register ceremony path)
    login: vi.fn(async () => ({ ok: false, code: 'invalid' } as const)),
    logout: vi.fn(async () => {}),
    resetWithPhrase: vi.fn(async () => ({ ok: false, code: 'invalid' } as const)),
    setupTotp: vi.fn(async () => ({ ok: false, code: 'invalid' } as const)),
    verifyTotp: vi.fn(async () => ({ ok: true } as const)),
    clearError: vi.fn(),
  } as Parameters<typeof useAuthStore.setState>[0]);

  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  // Seed a device-local notebook pointer so AuthedShell lands on the shell, not AllNotebooksScreen.
  await db.deviceState.put({ key: 'current-notebook', value: '00000000-0000-4000-8000-000000000001' });

  // Stub fetch so the shell (HomeView/syncEngine) doesn't crash when it mounts.
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/sync/push')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
    if (u.includes('/sync/pull')) return new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('register completes e2e (P0 ceremony-latch gate)', () => {
  it('phrase renders + shell absent → shell mounts only after Skip (finalizeAuth)', async () => {
    const user = userEvent.setup();
    render(<App />);

    // App boots; mocked init() resolves → isAuthed=false → auth-gate → /register route.
    await screen.findByRole('heading', { name: /Create your account/i });

    // Fill the register form
    await user.type(screen.getByRole('textbox', { name: /username/i }), 'testuser');
    await user.type(screen.getByLabelText('Password (8+ characters)'), 'password123');
    await user.type(screen.getByLabelText('Confirm password'), 'password123');
    await user.click(screen.getByRole('button', { name: /Create account/i }));

    // (1) REGRESSION CORE: phrase screen renders (RegisterRoute NOT unmounted by the gate).
    await screen.findByText(/Save your recovery phrase/i);
    // A phrase word is present in the DOM (the mock phrase delivered)
    expect(screen.getByText('word1')).toBeDefined();

    // (2) .shell is absent — isAuthing=true pins the gate to the auth-gate case
    expect(document.querySelector('.shell')).toBeNull();

    // Tick "I've saved my recovery phrase somewhere safe" → enable Continue
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /^Continue$/i }));

    // TOTP prompt appears (the gate is still pinned — isAuthing still true)
    await screen.findByText(/Add 2-factor authentication/i);
    expect(document.querySelector('.shell')).toBeNull();

    // (3) Skip → finalizeAuth fires atomically → selectBootView sees shell → shell mounts.
    await user.click(screen.getByRole('button', { name: /Skip for now/i }));
    // shell header mark — shell is now mounted. The mark is now a stacked brand block (δ span + " deltos"
    // text), so match the .shell__mark line rather than the whole "δ deltos" string across nodes.
    await screen.findByText(/deltos/i, { selector: '.shell__mark' });

    expect(document.querySelector('.shell')).not.toBeNull();
  });
});
