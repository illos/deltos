/**
 * FORCED-PHRASE ROUTE E2E — permanent done-gate invariant (jsdom).
 *
 * Regression gate for the abandon-path P0-belt: when login() returns recoveryRequired=true
 * (account created but phrase never finalized), the shell MUST NOT open until the user
 * saves + acknowledges a fresh recovery phrase in ForcedPhraseRoute.
 *
 * This is the route-level analogue of registerCeremony.render.test — covering the other
 * ceremony branch where the phrase gate fires at LOGIN instead of at REGISTER.
 *
 * Test sequence:
 *   1. Boot → auth-gate → /login
 *   2. Login form → login() resolves {ok:true, recoveryRequired:true}
 *   3. LoginRoute navigates to /forced-phrase (isAuthing=true pins auth-gate)
 *   4. ForcedPhraseRoute mounts → establishRecovery() → PhraseStep renders
 *   5. .shell is absent (isAuthing pin holds the gate)
 *   6. Ack checkbox + Continue → await finalizeAuth() → selectBootView sees shell
 *   7. Shell mounts — gate opens ONLY at ceremony-complete (the P0 latch)
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
  window.history.pushState({}, '', '/login');

  useAuthStore.setState({
    isAuthed: null,
    isAuthing: false,
    bearerToken: null,
    accountId: null,
    username: null,
    recoveryEstablished: null,
    sessionState: 'booting',
    error: null,
    // Cold boot: no session → auth-gate → /login
    init: vi.fn(async () => {
      useAuthStore.setState({ isAuthed: false, sessionState: 'unauthed' });
    }),
    // P0 latch actions
    beginAuth: vi.fn(() => { useAuthStore.setState({ isAuthing: true }); }),
    finalizeAuth: vi.fn(async () => {
      useAuthStore.setState({ isAuthed: true, isAuthing: false, sessionState: 'active', recoveryEstablished: true });
      return { ok: true } as const;
    }),
    // Login returns recoveryRequired=true — the abandon-path trigger
    login: vi.fn(async () => ({ ok: true, recoveryRequired: true } as const)),
    // establishRecovery: mints a fresh phrase (no network; returns SAMPLE_PHRASE)
    establishRecovery: vi.fn(async () => ({ ok: true, recoveryPhrase: SAMPLE_PHRASE } as const)),
    // Other stubs — not exercised in this path
    register: vi.fn(async () => ({ ok: false, code: 'invalid' } as const)),
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

  // Stub fetch so shell (HomeView/syncEngine) doesn't crash when it mounts.
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

describe('forced-phrase route e2e (P0-belt abandon-path latch)', () => {
  it('login(recoveryRequired) → phrase screen + shell absent → shell only after ack', async () => {
    const user = userEvent.setup();
    render(<App />);

    // App boots; mocked init() → isAuthed=false → auth-gate → /login
    await screen.findByRole('heading', { name: /Sign in to deltos/i });

    // Fill and submit the login form
    await user.type(screen.getByRole('textbox', { name: /username/i }), 'testuser');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /Sign in/i }));

    // (1) REGRESSION CORE: ForcedPhraseRoute mounts and shows the phrase screen.
    //     LoginRoute navigated to /forced-phrase; establishRecovery() resolved the phrase.
    await screen.findByText(/Save your recovery phrase/i);
    // A phrase word is present (mock phrase delivered via establishRecovery)
    expect(screen.getByText('word1')).toBeDefined();

    // (2) .shell is absent — isAuthing=true (set by beginAuth in LoginRoute) pins the gate
    expect(document.querySelector('.shell')).toBeNull();

    // Tick the required ack and hit Continue
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /^Continue$/i }));

    // (3) finalizeAuth fires → selectBootView sees isAuthed=true, isAuthing=false → shell mounts.
    // The shell mark is now the stacked brand block (δ span + " deltos" text), so match the .shell__mark line.
    await screen.findByText(/deltos/i, { selector: '.shell__mark' });
    expect(document.querySelector('.shell')).not.toBeNull();
  });
});
