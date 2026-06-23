/**
 * SettingsRoute render tests — closes the UI gate for task #42.
 *
 * ST-R1  Account section renders username, accountId, and sync status
 * ST-R2  Sign-out: button → confirm view → logout() + navigate /login
 * ST-R3  Recovery phrase: button → confirm view → establishRecovery() → PhraseStep mounts
 * ST-R4  2FA off: "Off" state + "Enable" button shown
 * ST-R5  2FA enable: Enable → QR setup → enter+verify code → verifyTotp() → back to list
 * ST-R6  2FA on + disable: "On" + "Disable" → code entry → disableTotp(code) → back to list
 *
 * Each test mounts SettingsRoute directly via MemoryRouter so the full
 * rendering path (store hooks → DOM) is exercised. The auth store is mocked
 * via useAuthStore.setState; totpEnabled and disableTotp now live in real store.ts (task #41).
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { screen, userEvent } from './renderHelpers.js';
import { useAuthStore } from '../src/auth/store.js';

// Expose __APP_VERSION__ to jsdom (vite define replaces it at build time).
(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test-sha';

// ── Mount helper ─────────────────────────────────────────────────────────────

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

// ── Common mock factory ───────────────────────────────────────────────────────

function mockAuthStore(overrides: Record<string, unknown> = {}) {
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
    logout: vi.fn(async () => {
      useAuthStore.setState({ isAuthed: false, bearerToken: null, sessionState: 'unauthed' });
    }),
    resetWithPhrase: vi.fn(async () => ({ ok: false, code: 'invalid' } as const)),
    setupTotp: vi.fn(async () => ({
      ok: true,
      secret: 'ABCDEF',
      uri: 'otpauth://totp/test?secret=ABCDEF',
    } as const)),
    verifyTotp: vi.fn(async () => ({ ok: true } as const)),
    disableTotp: vi.fn(async (_code: string) => ({ ok: true } as const)),
    establishRecovery: vi.fn(async () => ({
      ok: true,
      recoveryPhrase: 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w19 w20 w21 w22 w23 w24',
    } as const)),
    clearError: vi.fn(),
    ...overrides,
  } as Parameters<typeof useAuthStore.setState>[0]);
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockAuthStore();
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── ST-R1: Account section ────────────────────────────────────────────────────

describe('ST-R1 — Account section renders username, accountId, sync status', () => {
  it('shows alice / acct-abc-123 / Synced Online', async () => {
    await mountSettings();

    await waitFor(() => {
      expect(screen.queryByText('alice')).not.toBeNull();
    });

    expect(document.body.textContent).toContain('acct-abc-123');
    expect(screen.queryByText('Synced / Online')).not.toBeNull();
  });

  it('shows Offline status when sessionState=offline', async () => {
    mockAuthStore({ sessionState: 'offline' });
    await mountSettings();

    await waitFor(() => {
      expect(screen.queryByText(/offline/i)).not.toBeNull();
    });
  });
});

// ── ST-R2: Sign out flow ──────────────────────────────────────────────────────

describe('ST-R2 — Sign out: confirm step → logout() → /login', () => {
  it('clicking Sign out shows confirm view, then logout routes to /login', async () => {
    const user = userEvent.setup();
    await mountSettings();

    await waitFor(() => { expect(screen.queryByText('Sign out')).not.toBeNull(); });
    await user.click(screen.getByText('Sign out'));

    // Confirm view — danger action button present
    await waitFor(() => {
      expect(document.querySelector('.settings__action--danger')).not.toBeNull();
    });

    const logoutMock = useAuthStore.getState().logout as ReturnType<typeof vi.fn>;
    const dangerBtn = document.querySelector('.settings__action--danger') as HTMLButtonElement;
    fireEvent.click(dangerBtn);

    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalledOnce();
    });

    await waitFor(() => {
      expect(screen.queryByTestId('login-page')).not.toBeNull();
    });
  });
});

// ── ST-R3: Recovery phrase regenerate ────────────────────────────────────────

describe('ST-R3 — Recovery phrase: button → confirm → establishRecovery() → PhraseStep', () => {
  it('navigates to confirm, then calls establishRecovery and shows PhraseStep', async () => {
    const user = userEvent.setup();
    await mountSettings();

    await waitFor(() => { expect(screen.queryByText('Recovery phrase')).not.toBeNull(); });
    await user.click(screen.getByText('Recovery phrase'));

    // Confirm view with invalidation warning
    await waitFor(() => {
      expect(screen.queryByText(/invalidates the old one/i)).not.toBeNull();
    });

    await user.click(screen.getByText('Regenerate phrase'));

    const establishMock = useAuthStore.getState().establishRecovery as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(establishMock).toHaveBeenCalledOnce();
    });

    // PhraseStep mounts
    await waitFor(() => {
      expect(screen.queryByText(/Save your recovery phrase/i)).not.toBeNull();
    });

    expect(screen.queryByText('w1')).not.toBeNull();
  });
});

// ── ST-R4: 2FA off state ──────────────────────────────────────────────────────

describe('ST-R4 — 2FA off: shows Off status and Enable button', () => {
  it('renders "Off" and an Enable button when totpEnabled=false', async () => {
    mockAuthStore({ totpEnabled: false });
    await mountSettings();

    await waitFor(() => {
      expect(screen.queryByText('Two-factor authentication')).not.toBeNull();
    });

    // At least one 'Off' status (the 2FA one; the #69 custom-keyboard toggle also renders 'Off').
    expect(screen.getAllByText('Off').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /enable 2fa/i })).not.toBeNull();
  });
});

// ── ST-R5: 2FA enable flow ────────────────────────────────────────────────────

describe('ST-R5 — 2FA enable: Enable → QR setup → verify code → verifyTotp() → back to list', () => {
  it('Enable → setupTotp() → QR view → type code → verifyTotp() → back to settings list', async () => {
    const user = userEvent.setup();
    mockAuthStore({ totpEnabled: false });
    await mountSettings();

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /enable 2fa/i })).not.toBeNull();
    });

    await user.click(screen.getByRole('button', { name: /enable 2fa/i }));

    const setupMock = useAuthStore.getState().setupTotp as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(setupMock).toHaveBeenCalledOnce();
    });

    // QR setup view
    await waitFor(() => {
      expect(screen.queryByText(/verify and enable 2fa/i)).not.toBeNull();
    });

    await user.type(screen.getByLabelText('6-digit verification code'), '123456');
    await user.click(screen.getByRole('button', { name: /verify and enable 2fa/i }));

    const verifyMock = useAuthStore.getState().verifyTotp as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(verifyMock).toHaveBeenCalledWith('123456');
    });

    // After success, store swaps bearer internally — returns to settings list
    await waitFor(() => {
      expect(screen.queryByText('Two-factor authentication')).not.toBeNull();
    });
  });
});

// ── ST-R6: 2FA on + disable ──────────────────────────────────────────────────

describe('ST-R6 — 2FA on: Disable → code entry → disableTotp(code) → back to list', () => {
  it('totpEnabled=true shows On + Disable; code entry + confirm calls disableTotp, returns to list', async () => {
    const user = userEvent.setup();
    const disableMock = vi.fn(async (_code: string) => ({ ok: true } as const));
    mockAuthStore({ totpEnabled: true, disableTotp: disableMock });
    await mountSettings();

    await waitFor(() => {
      // At least one 'On' status (the 2FA one; the #69 §5 spellcheck toggle also defaults to 'On').
      expect(screen.queryAllByText('On').length).toBeGreaterThan(0);
    });

    expect(screen.queryByRole('button', { name: /disable 2fa/i })).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /disable 2fa/i }));

    // Code entry form appears
    await waitFor(() => {
      expect(screen.queryByLabelText(/authenticator code to disable 2fa/i)).not.toBeNull();
    });

    await user.type(screen.getByLabelText(/authenticator code to disable 2fa/i), '654321');

    // Disable button enabled now
    const dangerBtn = document.querySelector('.settings__action--danger') as HTMLButtonElement;
    fireEvent.click(dangerBtn);

    await waitFor(() => {
      expect(disableMock).toHaveBeenCalledWith('654321');
    });

    // After success, store swaps bearer + flips totpEnabled — returns to settings list
    await waitFor(() => {
      expect(screen.queryByText('Two-factor authentication')).not.toBeNull();
    });
  });
});
