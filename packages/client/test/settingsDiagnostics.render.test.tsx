/**
 * SettingsRoute → Diagnostics → "Export snapshot" button (mounted-DOM wiring).
 *
 * SD-1  the Diagnostics section + Export snapshot button + the security disclosure render
 * SD-2  tapping it dynamically imports diagnosticSnapshot and invokes exportDiagnosticSnapshot()
 *
 * The snapshot builder is mocked here (it has its own unit test, diagnosticSnapshot.test.ts); this
 * exercises the UI wiring + the lazy import → call.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { screen, userEvent } from './renderHelpers.js';
import { useAuthStore } from '../src/auth/store.js';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test-sha';
(globalThis as Record<string, unknown>).__BUILD_TIME__ = '2026-06-29T12:00:00.000Z';

const { exportMock } = vi.hoisted(() => ({ exportMock: vi.fn() }));
vi.mock('../src/lib/diagnosticSnapshot.js', () => ({ exportDiagnosticSnapshot: exportMock }));

async function mountSettings() {
  const { SettingsRoute } = await import('../src/routes/SettingsRoute.js');
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="/login" element={<div>Login</div>} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
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
    logout: vi.fn(async () => {}),
    establishRecovery: vi.fn(async () => ({ ok: false, code: 'invalid' } as const)),
    setupTotp: vi.fn(async () => ({ ok: false } as const)),
    verifyTotp: vi.fn(async () => ({ ok: true } as const)),
    disableTotp: vi.fn(async () => ({ ok: true } as const)),
  } as unknown as Parameters<typeof useAuthStore.setState>[0]);
  exportMock.mockReset();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SD-1 — Diagnostics section renders', () => {
  it('shows the Export snapshot button and the security disclosure', async () => {
    await mountSettings();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /export snapshot/i })).not.toBeNull();
    });
    expect(document.body.textContent).toContain('Excludes passwords, tokens, and keys');
  });
});

describe('SD-2 — tapping invokes the (lazy) exporter', () => {
  it('dynamically imports and calls exportDiagnosticSnapshot', async () => {
    const user = userEvent.setup();
    exportMock.mockResolvedValue(undefined);
    await mountSettings();

    await user.click(screen.getByRole('button', { name: /export snapshot/i }));

    await waitFor(() => {
      expect(exportMock).toHaveBeenCalledOnce();
    });
  });
});
