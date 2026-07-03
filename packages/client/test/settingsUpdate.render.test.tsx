/**
 * SettingsRoute "Update now" control + build-version readout (pwa-force-update).
 *
 * SU-1  About section renders the version SHA, the build timestamp, and an "Update now" button
 * SU-2  tapping invokes forceUpdate(); 'latest' → "You're on the latest version."
 * SU-3  'updating' (a reload is in flight) → button shows "Updating…" and stays disabled
 * SU-4  'offline' → "Connect to the internet to check for updates."
 *
 * forceUpdate (the SW activation/reload logic) is mocked here — it has its own unit test
 * (forceUpdate.test.ts). This test exercises the UI wiring: button → flow → transient states.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { screen, userEvent } from './renderHelpers.js';
import { useAuthStore } from '../src/auth/store.js';

// vite `define` replaces these at build; expose to jsdom.
(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test-sha';
(globalThis as Record<string, unknown>).__BUILD_TIME__ = '2026-06-28T12:00:00.000Z';

const { forceUpdateMock } = vi.hoisted(() => ({ forceUpdateMock: vi.fn() }));
vi.mock('../src/lib/forceUpdate.js', () => ({ forceUpdate: forceUpdateMock }));

async function mountSettings() {
  const { SettingsRoute } = await import('../src/routes/SettingsRoute.js');
  return render(
    <MemoryRouter initialEntries={['/settings/about']}>
      <Routes>
        <Route path="/settings/:tab" element={<SettingsRoute />} />
        <Route path="/login" element={<div data-testid="login-page">Login</div>} />
        <Route path="/" element={<div data-testid="home-page">Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

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
    logout: vi.fn(async () => {}),
    establishRecovery: vi.fn(async () => ({ ok: false, code: 'invalid' } as const)),
    setupTotp: vi.fn(async () => ({ ok: false } as const)),
    verifyTotp: vi.fn(async () => ({ ok: true } as const)),
    disableTotp: vi.fn(async () => ({ ok: true } as const)),
  } as unknown as Parameters<typeof useAuthStore.setState>[0]);
}

beforeEach(() => {
  mockAuthStore();
  forceUpdateMock.mockReset();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SU-1 — About shows version, build time, and Update now button', () => {
  it('renders the SHA, a build timestamp, and the button', async () => {
    forceUpdateMock.mockResolvedValue('latest');
    await mountSettings();

    await waitFor(() => {
      expect(screen.queryByText('test-sha')).not.toBeNull();
    });
    // Build timestamp is rendered (date portion of the injected ISO build time).
    expect(document.body.textContent).toContain('2026-06');
    expect(screen.queryByRole('button', { name: /update now/i })).not.toBeNull();
  });
});

describe('SU-2 — tap invokes forceUpdate; latest → "on the latest version"', () => {
  it('calls forceUpdate and shows the latest-version hint', async () => {
    const user = userEvent.setup();
    forceUpdateMock.mockResolvedValue('latest');
    await mountSettings();

    await user.click(screen.getByRole('button', { name: /update now/i }));

    expect(forceUpdateMock).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByText(/on the latest version/i)).not.toBeNull();
    });
  });
});

describe('SU-3 — updating keeps the button busy (reload in flight)', () => {
  it('shows "Updating…" and disables the button', async () => {
    const user = userEvent.setup();
    forceUpdateMock.mockResolvedValue('updating');
    await mountSettings();

    await user.click(screen.getByRole('button', { name: /update now/i }));

    await waitFor(() => {
      expect(screen.queryByText('Updating…')).not.toBeNull();
    });
    const btn = screen.getByRole('button', { name: /update now/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe('SU-4 — offline shows a graceful hint', () => {
  it('shows the connect-to-the-internet hint', async () => {
    const user = userEvent.setup();
    forceUpdateMock.mockResolvedValue('offline');
    await mountSettings();

    await user.click(screen.getByRole('button', { name: /update now/i }));

    await waitFor(() => {
      expect(screen.queryByText(/connect to the internet/i)).not.toBeNull();
    });
  });
});
