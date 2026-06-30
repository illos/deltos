/**
 * SessionsSection render tests — closes the UI gate for the Phase-2 "Active sessions" kill-switch.
 *
 * Mounts the REAL routed SettingsRoute tree (MemoryRouter) so the section renders inside the actual
 * settings screen, and drives the sessions API at the fetch seam (the same place sessionsClient talks to
 * the worker). Asserts real DOM:
 *
 *  SS-R1  Active sessions list renders each session (label, "This device" badge on the current one)
 *  SS-R2  Per-session revoke: Sign out → Confirm → DELETE /api/auth/sessions/:familyId → row drops
 *  SS-R3  "Sign out everywhere else" calls POST signout-others; ABSENT when only the current session exists
 *  SS-R4  Error: a failing list load renders the error + a Retry affordance
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { screen, userEvent } from './renderHelpers.js';
import { useAuthStore } from '../src/auth/store.js';
import type { LoginSession } from '../src/lib/sessionsClient.js';

// Build-time defines (vite replaces these; jsdom needs them set).
(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test-sha';
(globalThis as Record<string, unknown>).__BUILD_TIME__ = '2026-06-28T12:00:00.000Z';

// ── Mount the real routed Settings tree ────────────────────────────────────────

async function mountSettings() {
  const { SettingsRoute } = await import('../src/routes/SettingsRoute.js');
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="/login" element={<div data-testid="login-page">Login</div>} />
        <Route path="/" element={<div data-testid="home-page">Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function section() {
  return within(screen.getByRole('region', { name: /active sessions/i }));
}

// ── Auth store mock (signed-in, bearer present so no re-mint fires) ─────────────

function mockAuthStore() {
  useAuthStore.setState({
    isAuthed: true,
    isAuthing: false,
    bearerToken: 'tok',
    accountId: 'acct-abc-123',
    username: 'alice',
    recoveryEstablished: true,
    sessionState: 'active',
    totpEnabled: false,
    error: null,
    init: vi.fn(async () => {}),
    beginAuth: vi.fn(),
    finalizeAuth: vi.fn(async () => ({ ok: true } as const)),
    register: vi.fn(async () => ({ ok: false, code: 'invalid' } as const)),
    login: vi.fn(async () => ({ ok: false, code: 'invalid' } as const)),
    logout: vi.fn(async () => {}),
    resetWithPhrase: vi.fn(async () => ({ ok: false, code: 'invalid' } as const)),
    setupTotp: vi.fn(async () => ({ ok: true, secret: 'A', uri: 'otpauth://t' } as const)),
    verifyTotp: vi.fn(async () => ({ ok: true } as const)),
    disableTotp: vi.fn(async () => ({ ok: true } as const)),
    establishRecovery: vi.fn(async () => ({ ok: true, recoveryPhrase: 'w' } as const)),
    remintBearer: vi.fn(async () => 'ok' as const),
    clearError: vi.fn(),
  } as Parameters<typeof useAuthStore.setState>[0]);
}

// ── Fetch mock: routes /api/auth/sessions by method over a mutable in-memory list ─

function installFetchMock(initial: LoginSession[], opts: { listStatus?: number } = {}) {
  let sessions = [...initial];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/api/auth/sessions/signout-others') && method === 'POST') {
      const before = sessions.length;
      sessions = sessions.filter((s) => s.current);
      return new Response(JSON.stringify({ revoked: before - sessions.length }), { status: 200 });
    }
    if (url.includes('/api/auth/sessions')) {
      if (method === 'GET') {
        if (opts.listStatus && opts.listStatus !== 200) {
          return new Response(JSON.stringify({ error: 'x' }), { status: opts.listStatus });
        }
        return new Response(JSON.stringify({ sessions }), { status: 200 });
      }
      if (method === 'DELETE') {
        const id = decodeURIComponent(url.split('/').pop() ?? '');
        sessions = sessions.filter((s) => s.familyId !== id);
        return new Response(JSON.stringify({ familyId: id, revoked: true }), { status: 200 });
      }
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function seed(label: string | null, familyId: string, current = false): LoginSession {
  return { familyId, label, createdAt: '2026-06-20T08:00:00.000Z', current };
}

beforeEach(() => {
  mockAuthStore();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── SS-R1 ─────────────────────────────────────────────────────────────────────

describe('SS-R1 — active sessions list', () => {
  it('renders each session with its label and a "This device" badge on the current one', async () => {
    installFetchMock([
      seed('iPhone', 'f1', true),
      seed('MacBook', 'f2'),
      seed(null, 'f3'), // null label → "Unknown device"
    ]);
    await mountSettings();

    const s = section();
    await waitFor(() => {
      expect(s.queryByText('iPhone')).not.toBeNull();
    });
    expect(s.queryByText('MacBook')).not.toBeNull();
    expect(s.queryByText('Unknown device')).not.toBeNull();
    // The current device is badged.
    expect(s.queryByText(/This device/i)).not.toBeNull();
  });

  it('renders the empty state when there are no sessions', async () => {
    installFetchMock([]);
    await mountSettings();

    const s = section();
    await waitFor(() => {
      expect(s.queryByText(/No active sessions/i)).not.toBeNull();
    });
  });
});

// ── SS-R2 ─────────────────────────────────────────────────────────────────────

describe('SS-R2 — per-session revoke removes the row', () => {
  it('Sign out → Confirm → DELETE :familyId → row disappears', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetchMock([seed('iPhone', 'f1', true), seed('Old laptop', 'f9')]);
    await mountSettings();

    const s = section();
    await waitFor(() => expect(s.queryByText('Old laptop')).not.toBeNull());

    await user.click(s.getByRole('button', { name: /Sign out Old laptop/i }));
    await user.click(s.getByRole('button', { name: /Confirm sign out Old laptop/i }));

    await waitFor(() => {
      expect(s.queryByText('Old laptop')).toBeNull();
    });
    // The current device is untouched.
    expect(s.queryByText('iPhone')).not.toBeNull();

    const deleteCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCall).toBeDefined();
    expect(String(deleteCall![0])).toContain('/api/auth/sessions/f9');
  });

  it('warns before revoking the CURRENT session', async () => {
    const user = userEvent.setup();
    installFetchMock([seed('iPhone', 'f1', true), seed('MacBook', 'f2')]);
    await mountSettings();

    const s = section();
    await waitFor(() => expect(s.queryByText('iPhone')).not.toBeNull());

    await user.click(s.getByRole('button', { name: /Sign out iPhone/i }));
    // Confirm affordance for the current device spells out the consequence.
    expect(s.queryByText(/sign you out on/i)).not.toBeNull();
    expect(s.queryByRole('button', { name: /Confirm sign out iPhone/i })).not.toBeNull();
  });
});

// ── SS-R3 ─────────────────────────────────────────────────────────────────────

describe('SS-R3 — sign out everywhere else', () => {
  it('calls POST signout-others and drops the other rows (keeps current)', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetchMock([
      seed('iPhone', 'f1', true),
      seed('MacBook', 'f2'),
      seed('Old phone', 'f3'),
    ]);
    await mountSettings();

    const s = section();
    await waitFor(() => expect(s.queryByText('MacBook')).not.toBeNull());

    await user.click(s.getByRole('button', { name: /Sign out everywhere else/i }));
    // Confirm step then the danger action.
    const confirmBtns = s.getAllByRole('button', { name: /Sign out everywhere else/i });
    await user.click(confirmBtns[confirmBtns.length - 1]);

    await waitFor(() => {
      expect(s.queryByText('MacBook')).toBeNull();
    });
    expect(s.queryByText('Old phone')).toBeNull();
    expect(s.queryByText('iPhone')).not.toBeNull();

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        (init as RequestInit | undefined)?.method === 'POST' &&
        String(url).includes('/signout-others'),
    );
    expect(postCall).toBeDefined();
  });

  it('is ABSENT when only the current session exists', async () => {
    installFetchMock([seed('iPhone', 'f1', true)]);
    await mountSettings();

    const s = section();
    await waitFor(() => expect(s.queryByText('iPhone')).not.toBeNull());
    expect(s.queryByRole('button', { name: /Sign out everywhere else/i })).toBeNull();
  });
});

// ── SS-R4 ─────────────────────────────────────────────────────────────────────

describe('SS-R4 — list load error', () => {
  it('renders an error message and a Retry button when the list call fails', async () => {
    installFetchMock([], { listStatus: 500 });
    await mountSettings();

    const s = section();
    await waitFor(() => {
      expect(s.queryByText(/Could not load sessions/i)).not.toBeNull();
    });
    expect(s.queryByRole('button', { name: 'Retry' })).not.toBeNull();
  });
});
