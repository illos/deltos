/**
 * SettingsRoute render tests — the six-tab shell (settings-revamp) + the re-homed flows.
 *
 * Shell (ST-R8..R11):
 *   ST-R8   Mobile: /settings = the 6-row grouped list; tapping a row pushes its sub-screen; back returns.
 *   ST-R9   Desktop: /settings redirects to account; the rail shows 6 tabs; clicking a rail row swaps the
 *           content pane; the active row gets the active class. No "Security" TAB anywhere.
 *   ST-R10  Tab-content mapping: Account = username + Sign out + 2FA; Activity = sessions + activity feed.
 *   ST-R11  Unknown tab redirects (desktop → account, mobile → list).
 *
 * Re-homed flows (ST-R1..R7) — behavior-preserving, now mounted at their tab route:
 *   ST-R1  Account renders username, accountId, sync status            (/settings/account)
 *   ST-R2  Sign-out: button → confirm → logout() + navigate /login     (/settings/account)
 *   ST-R3  Recovery phrase: button → confirm → establishRecovery()     (/settings/account)
 *   ST-R4  2FA off: "Off" + "Enable" shown                             (/settings/account)
 *   ST-R5  2FA enable: Enable → QR → verify → verifyTotp() → list       (/settings/account)
 *   ST-R6  2FA on + disable: Disable → code → disableTotp() → list      (/settings/account)
 *   ST-R7  Custom-keyboard toggle is installed-PWA-only                 (/settings/editor)
 *
 * The auth store is mocked via useAuthStore.setState; useIsDesktop is mocked per-suite.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { screen, userEvent } from './renderHelpers.js';
import { useAuthStore } from '../src/auth/store.js';
import { SettingsRail } from '../src/routes/settings/SettingsRail.js';

// Expose the build-time defines to jsdom (vite `define` replaces them at build time).
(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test-sha';
(globalThis as Record<string, unknown>).__BUILD_TIME__ = '2026-06-28T12:00:00.000Z';

// The "Custom keyboard (experimental)" row shows only where the keypad can ENGAGE: installed PWA AND
// touch-first. Mock both hooks with mutable flags defaulting TRUE; ST-R7 flips them to test the gate.
let mockInstalledPwa = true;
let mockTouchPrimary = true;
vi.mock('../src/lib/useInstalledPwa.js', () => ({ useInstalledPwa: () => mockInstalledPwa }));
vi.mock('../src/lib/useTouchPrimary.js', () => ({ useTouchPrimary: () => mockTouchPrimary }));

// Device class drives the shell fork (mobile list-vs-sub-screen | desktop content pane). Mutable, default
// mobile (matches jsdom's no-matchMedia → useIsDesktop() false).
let mockIsDesktop = false;
vi.mock('../src/lib/useIsDesktop.js', () => ({ useIsDesktop: () => mockIsDesktop }));

// ── Mount helpers ──────────────────────────────────────────────────────────────

// Mobile / route-driven mount: the shell's <Routes> for /settings + /settings/:tab.
async function mountSettings(initial = '/settings/account') {
  const { SettingsRoute } = await import('../src/routes/SettingsRoute.js');
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="/settings/:tab" element={<SettingsRoute />} />
        <Route path="/login" element={<div data-testid="login-page">Login</div>} />
        <Route path="/" element={<div data-testid="home-page">Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// Desktop mount: the rail (middle pane) + the content <Routes> (right pane), mirroring how
// ThreeRegionShell composes the two on /settings.
async function mountDesktop(initial = '/settings') {
  mockIsDesktop = true;
  const { SettingsRoute } = await import('../src/routes/SettingsRoute.js');
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <SettingsRail />
      <Routes>
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="/settings/:tab" element={<SettingsRoute />} />
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
  mockInstalledPwa = true; // installed-PWA + touch-first by default → the custom-keyboard toggle is shown
  mockTouchPrimary = true;
  mockIsDesktop = false; // mobile by default; desktop suites flip it via mountDesktop
  mockAuthStore();
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ══ ST-R8: Mobile grouped list + push navigation ════════════════════════════════

describe('ST-R8 — Mobile: /settings list → tap a row → sub-screen → back', () => {
  it('renders the 6-row list, tapping Appearance pushes its sub-screen, back returns to the list', async () => {
    const user = userEvent.setup();
    await mountSettings('/settings');

    // The grouped list: the big "Settings" title + all six tab labels as rows.
    await waitFor(() => {
      expect(document.querySelector('.settings__screen-title')).not.toBeNull();
    });
    const rows = document.querySelectorAll('.settings__list-row');
    expect(rows.length).toBe(6);
    for (const label of ['Account', 'Appearance', 'Connections', 'Activity', 'Editor', 'About']) {
      expect(screen.queryByText(label)).not.toBeNull();
    }

    // Tap Appearance → its sub-screen (the Palette group is an Appearance-only marker).
    await user.click(screen.getByText('Appearance'));
    await waitFor(() => {
      expect(screen.queryByText('Palette')).not.toBeNull();
    });
    // The list is gone (pushed over).
    expect(document.querySelector('.settings__list-row')).toBeNull();

    // Back "‹ Settings" pops to the list.
    await user.click(screen.getByText('‹ Settings'));
    await waitFor(() => {
      expect(document.querySelectorAll('.settings__list-row').length).toBe(6);
    });
  });
});

// ══ ST-R9: Desktop rail + content pane ══════════════════════════════════════════

describe('ST-R9 — Desktop: /settings → account; rail 6 tabs; click swaps pane; active class', () => {
  it('redirects to Account, shows a 6-tab rail (no Security tab), and swaps the pane on click', async () => {
    const user = userEvent.setup();
    await mountDesktop('/settings');

    // /settings redirected to the Account body (Username is an account marker).
    await waitFor(() => {
      expect(screen.queryByText('Username')).not.toBeNull();
    });

    // Rail: exactly the six tabs, in order — and NO "Security" tab (folded into Account).
    const railLabels = Array.from(document.querySelectorAll('.settings-rail__tab-label')).map((n) => n.textContent);
    expect(railLabels).toEqual(['Account', 'Appearance', 'Connections', 'Activity', 'Editor', 'About']);
    expect(railLabels).not.toContain('Security');

    // Active-row styling on the current (Account) tab.
    await waitFor(() => {
      const active = document.querySelector('.settings-rail__tab--active');
      expect(active?.querySelector('.settings-rail__tab-label')?.textContent).toBe('Account');
    });

    // Click the Appearance rail row → content pane swaps (Palette marker), active class moves.
    await user.click(screen.getByText('Appearance'));
    await waitFor(() => {
      expect(screen.queryByText('Palette')).not.toBeNull();
    });
    const active = document.querySelector('.settings-rail__tab--active');
    expect(active?.querySelector('.settings-rail__tab-label')?.textContent).toBe('Appearance');
  });
});

// ══ ST-R10: Tab-content mapping ═════════════════════════════════════════════════

describe('ST-R10 — Tab content mapping', () => {
  it('Account tab holds username + Sign out + Two-factor', async () => {
    await mountSettings('/settings/account');
    await waitFor(() => { expect(screen.queryByText('alice')).not.toBeNull(); });
    expect(screen.queryByText('Sign out')).not.toBeNull();
    expect(screen.queryByText('Two-factor authentication')).not.toBeNull();
  });

  it('Activity tab holds the sessions list + the activity feed', async () => {
    await mountSettings('/settings/activity');
    await waitFor(() => {
      expect(screen.queryByText('Active sessions')).not.toBeNull();
    });
    expect(screen.queryByText('Account activity')).not.toBeNull();
  });
});

// ══ ST-R11: Unknown-tab redirect ════════════════════════════════════════════════

describe('ST-R11 — Unknown tab redirects', () => {
  it('desktop: /settings/security (no such tab) lands on Account', async () => {
    await mountDesktop('/settings/security');
    await waitFor(() => { expect(screen.queryByText('Username')).not.toBeNull(); });
    const active = document.querySelector('.settings-rail__tab--active');
    expect(active?.querySelector('.settings-rail__tab-label')?.textContent).toBe('Account');
  });

  it('mobile: /settings/bogus redirects to the grouped list', async () => {
    await mountSettings('/settings/bogus');
    await waitFor(() => {
      expect(document.querySelectorAll('.settings__list-row').length).toBe(6);
    });
  });
});

// ══ ST-R1: Account section ══════════════════════════════════════════════════════

describe('ST-R1 — Account section renders username, accountId, sync status', () => {
  it('shows alice / acct-abc-123 / Synced Online', async () => {
    await mountSettings('/settings/account');

    await waitFor(() => {
      expect(screen.queryByText('alice')).not.toBeNull();
    });

    expect(document.body.textContent).toContain('acct-abc-123');
    expect(screen.queryByText('Synced / Online')).not.toBeNull();
  });

  it('shows Offline status when sessionState=offline', async () => {
    mockAuthStore({ sessionState: 'offline' });
    await mountSettings('/settings/account');

    await waitFor(() => {
      expect(screen.queryByText(/offline/i)).not.toBeNull();
    });
  });
});

// ══ ST-R2: Sign out flow ════════════════════════════════════════════════════════

describe('ST-R2 — Sign out: confirm step → logout() → /login', () => {
  it('clicking Sign out shows confirm view, then logout routes to /login', async () => {
    const user = userEvent.setup();
    await mountSettings('/settings/account');

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

// ══ ST-R3: Recovery phrase regenerate ═══════════════════════════════════════════

describe('ST-R3 — Recovery phrase: button → confirm → establishRecovery() → PhraseStep', () => {
  it('navigates to confirm, then calls establishRecovery and shows PhraseStep', async () => {
    const user = userEvent.setup();
    await mountSettings('/settings/account');

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

// ══ ST-R4: 2FA off state ════════════════════════════════════════════════════════

describe('ST-R4 — 2FA off: shows Off status and Enable button', () => {
  it('renders "Off" and an Enable button when totpEnabled=false', async () => {
    mockAuthStore({ totpEnabled: false });
    await mountSettings('/settings/account');

    await waitFor(() => {
      expect(screen.queryByText('Two-factor authentication')).not.toBeNull();
    });

    expect(screen.getAllByText('Off').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /enable 2fa/i })).not.toBeNull();
  });
});

// ══ ST-R5: 2FA enable flow ══════════════════════════════════════════════════════

describe('ST-R5 — 2FA enable: Enable → QR setup → verify code → verifyTotp() → back to list', () => {
  it('Enable → setupTotp() → QR view → type code → verifyTotp() → back to settings list', async () => {
    const user = userEvent.setup();
    mockAuthStore({ totpEnabled: false });
    await mountSettings('/settings/account');

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

    // After success, store swaps bearer internally — returns to the Account list
    await waitFor(() => {
      expect(screen.queryByText('Two-factor authentication')).not.toBeNull();
    });
  });
});

// ══ ST-R6: 2FA on + disable ═════════════════════════════════════════════════════

describe('ST-R6 — 2FA on: Disable → code entry → disableTotp(code) → back to list', () => {
  it('totpEnabled=true shows On + Disable; code entry + confirm calls disableTotp, returns to list', async () => {
    const user = userEvent.setup();
    const disableMock = vi.fn(async (_code: string) => ({ ok: true } as const));
    mockAuthStore({ totpEnabled: true, disableTotp: disableMock });
    await mountSettings('/settings/account');

    await waitFor(() => {
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

    // After success, store swaps bearer + flips totpEnabled — returns to the Account list
    await waitFor(() => {
      expect(screen.queryByText('Two-factor authentication')).not.toBeNull();
    });
  });
});

// ══ ST-R7: Custom-keyboard toggle is installed-PWA-only (now in the Editor tab) ══════

describe('ST-R7 — Custom keyboard toggle: shown in installed PWA, hidden in a browser tab', () => {
  it('installed PWA: the "Custom keyboard (experimental)" row is present', async () => {
    mockInstalledPwa = true;
    await mountSettings('/settings/editor');
    await waitFor(() => {
      expect(screen.queryByText('Custom keyboard (experimental)')).not.toBeNull();
    });
  });

  it('plain browser tab (not installed): the toggle row is hidden entirely', async () => {
    mockInstalledPwa = false;
    await mountSettings('/settings/editor');
    // The Developer section still renders (Spellcheck lives there), but the custom-keyboard row is gone.
    await waitFor(() => {
      expect(screen.queryByText('Spellcheck')).not.toBeNull();
    });
    expect(screen.queryByText('Custom keyboard (experimental)')).toBeNull();
  });

  it('DESKTOP-installed PWA (standalone but pointer-fine): the toggle row is hidden too', async () => {
    mockInstalledPwa = true;
    mockTouchPrimary = false;
    await mountSettings('/settings/editor');
    await waitFor(() => {
      expect(screen.queryByText('Spellcheck')).not.toBeNull();
    });
    expect(screen.queryByText('Custom keyboard (experimental)')).toBeNull();
  });
});
