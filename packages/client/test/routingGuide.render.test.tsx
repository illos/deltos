/**
 * RoutingGuideSection render tests — closes the UI gate for the note-routing-guide feature.
 *
 * Mounts the REAL routed SettingsRoute tree (MemoryRouter) so the section renders inside the actual settings
 * screen, and drives the routing-guide API at the fetch seam (where routingGuideClient talks to the worker).
 * Asserts real DOM:
 *
 *  RG-R1  GET on mount populates the textarea with the existing guide.
 *  RG-R2  Edit → Save → PUT /api/account/routing-guide with the typed body.
 *  RG-R3  Edit → blur → PUT (save-on-blur).
 *  RG-R4  Clear the textarea → Save → PUT clears the guide (null).
 *  RG-R5  A failing load renders the error + a Retry affordance.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { screen, userEvent } from './renderHelpers.js';
import { useAuthStore } from '../src/auth/store.js';

// Build-time defines (vite replaces these; jsdom needs them set).
(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test-sha';
(globalThis as Record<string, unknown>).__BUILD_TIME__ = '2026-06-28T12:00:00.000Z';

async function mountSettings() {
  const { SettingsRoute } = await import('../src/routes/SettingsRoute.js');
  return render(
    <MemoryRouter initialEntries={['/settings/connections']}>
      <Routes>
        <Route path="/settings/:tab" element={<SettingsRoute />} />
        <Route path="/login" element={<div data-testid="login-page">Login</div>} />
        <Route path="/" element={<div data-testid="home-page">Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function section() {
  return within(screen.getByRole('region', { name: /note routing guide/i }));
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

/** Route /api/account/routing-guide by method; everything else (other Settings sections) → benign 200 {}. */
function installFetchMock(initial: string | null, opts: { getStatus?: number } = {}) {
  let guide = initial;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/api/account/routing-guide')) {
      if (method === 'GET') {
        if (opts.getStatus && opts.getStatus !== 200) {
          return new Response(JSON.stringify({ error: 'x' }), { status: opts.getStatus });
        }
        return new Response(JSON.stringify({ routingGuide: guide }), { status: 200 });
      }
      if (method === 'PUT') {
        const body = init?.body ? (JSON.parse(init.body as string) as { routingGuide: string | null }) : { routingGuide: null };
        const v = body.routingGuide;
        guide = v && v.trim() ? v : null; // mirror server normalization (empty/whitespace → null)
        return new Response(JSON.stringify({ routingGuide: guide }), { status: 200 });
      }
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function lastPut(fetchMock: ReturnType<typeof installFetchMock>): { routingGuide: string | null } | undefined {
  const puts = fetchMock.mock.calls.filter(
    ([u, init]) => String(u).includes('/api/account/routing-guide') && (init as RequestInit | undefined)?.method === 'PUT',
  );
  const last = puts[puts.length - 1];
  return last ? (JSON.parse((last[1] as RequestInit).body as string) as { routingGuide: string | null }) : undefined;
}

beforeEach(() => {
  mockAuthStore();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── RG-R1 ─────────────────────────────────────────────────────────────────
describe('RG-R1 — GET on mount populates the textarea', () => {
  it('shows the existing guide in the textarea', async () => {
    installFetchMock('Dev: coding, homelab\nLife: home + property');
    await mountSettings();

    const s = section();
    await waitFor(() => {
      const ta = s.getByLabelText('Routing guide') as HTMLTextAreaElement;
      expect(ta.value).toBe('Dev: coding, homelab\nLife: home + property');
    });
  });

  it('shows an empty textarea when the guide is unset (null)', async () => {
    installFetchMock(null);
    await mountSettings();
    const s = section();
    await waitFor(() => {
      const ta = s.getByLabelText('Routing guide') as HTMLTextAreaElement;
      expect(ta.value).toBe('');
    });
  });
});

// ── RG-R2 ─────────────────────────────────────────────────────────────────
describe('RG-R2 — edit + Save PUTs the typed body', () => {
  it('Save fires PUT /api/account/routing-guide with the new guide', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetchMock('old guide');
    await mountSettings();
    const s = section();

    const ta = (await waitFor(() => s.getByLabelText('Routing guide'))) as HTMLTextAreaElement;
    await user.clear(ta);
    await user.type(ta, 'Dev only: everything technical');
    await user.click(s.getByRole('button', { name: 'Save routing guide' }));

    await waitFor(() => expect(lastPut(fetchMock)).toEqual({ routingGuide: 'Dev only: everything technical' }));
  });
});

// ── RG-R3 ─────────────────────────────────────────────────────────────────
describe('RG-R3 — save on blur', () => {
  it('blurring the textarea after a change fires the PUT', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetchMock('start');
    await mountSettings();
    const s = section();

    const ta = (await waitFor(() => s.getByLabelText('Routing guide'))) as HTMLTextAreaElement;
    await user.clear(ta);
    await user.type(ta, 'blurred value');
    fireEvent.blur(ta);

    await waitFor(() => expect(lastPut(fetchMock)).toEqual({ routingGuide: 'blurred value' }));
  });
});

// ── RG-R4 ─────────────────────────────────────────────────────────────────
describe('RG-R4 — clearing the guide', () => {
  it('emptying the textarea + Save clears the guide (null)', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetchMock('to be cleared');
    await mountSettings();
    const s = section();

    const ta = (await waitFor(() => s.getByLabelText('Routing guide'))) as HTMLTextAreaElement;
    await user.clear(ta);
    await user.click(s.getByRole('button', { name: 'Save routing guide' }));

    await waitFor(() => {
      const put = lastPut(fetchMock);
      expect(put).toBeDefined();
      expect(put!.routingGuide == null || put!.routingGuide === '').toBe(true); // cleared
    });
  });
});

// ── RG-R5 ─────────────────────────────────────────────────────────────────
describe('RG-R5 — load error', () => {
  it('renders an error and a Retry button when the GET fails', async () => {
    installFetchMock(null, { getStatus: 500 });
    await mountSettings();
    const s = section();
    await waitFor(() => expect(s.queryByText(/Could not load the routing guide/i)).not.toBeNull());
    expect(s.queryByRole('button', { name: 'Retry' })).not.toBeNull();
  });
});
