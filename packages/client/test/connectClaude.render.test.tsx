/**
 * ConnectClaudeSection render tests — closes the UI gate (llm-mcp-integration.md §5).
 *
 * Mounts the REAL routed SettingsRoute tree (MemoryRouter) so the section renders inside the actual
 * settings screen, and drives the agent-token API at the fetch seam (the same place agentTokensClient
 * talks to the worker). Asserts real DOM:
 *
 *  CC-R1  Active connections list renders each token (label + Read-only meta)
 *  CC-R2  Generate flow: Generate → label → Create → POST /api/agent-tokens → raw token shown ONCE + warning
 *  CC-R3  Copy: the once-shown token's Copy button writes the token to the clipboard
 *  CC-R4  Revoke: Revoke → Confirm → DELETE /api/agent-tokens/:grantId → list drops the row
 *  CC-R5  Error: a failing list load renders the error + a Retry affordance
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { screen, userEvent } from './renderHelpers.js';
import { useAuthStore } from '../src/auth/store.js';
import type { AgentToken } from '@deltos/shared';

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
  return within(screen.getByRole('region', { name: /connect to claude/i }));
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

// ── Fetch mock: routes /api/agent-tokens by method over a mutable in-memory list ─

function installFetchMock(
  initial: AgentToken[],
  opts: { listStatus?: number; mintStatus?: number; mintErrorCode?: string } = {},
) {
  let tokens = [...initial];
  let minted = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/api/agent-tokens')) {
      if (method === 'GET') {
        if (opts.listStatus && opts.listStatus !== 200) {
          return new Response(JSON.stringify({ error: 'x' }), { status: opts.listStatus });
        }
        return new Response(JSON.stringify({ tokens }), { status: 200 });
      }
      if (method === 'POST') {
        if (opts.mintStatus && opts.mintStatus !== 201) {
          // Step-up rejection (H1): the server 401s with an error code; nothing is minted.
          return new Response(
            JSON.stringify({ error: { code: opts.mintErrorCode ?? 'password_invalid', message: 'nope' } }),
            { status: opts.mintStatus },
          );
        }
        minted += 1;
        const body = init?.body ? (JSON.parse(init.body as string) as { label?: string }) : {};
        const created: AgentToken = {
          grantId: `grant-${minted}`,
          label: body.label ?? null,
          scope: ['read', 'search'],
          resourceKind: 'workspace',
          resourceId: null,
          createdAt: '2026-06-29T10:00:00.000Z',
        };
        tokens = [...tokens, created];
        return new Response(JSON.stringify({ ...created, token: `dltos_agent_SECRET_${minted}` }), {
          status: 201,
        });
      }
      if (method === 'DELETE') {
        const id = decodeURIComponent(url.split('/').pop() ?? '');
        tokens = tokens.filter((t) => t.grantId !== id);
        return new Response(JSON.stringify({ grantId: id, revoked: true }), { status: 200 });
      }
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function seed(label: string, grantId: string): AgentToken {
  return {
    grantId,
    label,
    scope: ['read', 'search'],
    resourceKind: 'workspace',
    resourceId: null,
    createdAt: '2026-06-20T08:00:00.000Z',
  };
}

beforeEach(() => {
  mockAuthStore();
  localStorage.clear();
  // navigator.clipboard is provided by userEvent.setup() in the copy test; we assert on its contents.
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── CC-R1 ───────────────────────────────────────────────────────────────────

describe('CC-R1 — active connections list', () => {
  it('renders each token with label and Read-only meta', async () => {
    installFetchMock([seed('Claude Desktop', 'g1'), seed('Phone', 'g2')]);
    await mountSettings();

    const s = section();
    await waitFor(() => {
      expect(s.queryByText('Claude Desktop')).not.toBeNull();
    });
    expect(s.queryByText('Phone')).not.toBeNull();
    // Meta line states read-only scope.
    expect(s.queryAllByText(/Read-only/i).length).toBeGreaterThan(0);
  });

  it('renders the empty state when there are no tokens', async () => {
    installFetchMock([]);
    await mountSettings();

    const s = section();
    await waitFor(() => {
      expect(s.queryByText(/No connections yet/i)).not.toBeNull();
    });
  });
});

// ── CC-R2 ───────────────────────────────────────────────────────────────────

describe('CC-R2 — generate flow shows the raw token exactly once', () => {
  it('Generate → label → Create → POST → token + once-only warning render', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetchMock([]);
    await mountSettings();

    const s = section();
    await waitFor(() => expect(s.queryByText(/No connections yet/i)).not.toBeNull());

    await user.click(s.getByRole('button', { name: 'Generate token' }));
    await user.type(s.getByLabelText('Token label'), 'Claude Code');
    await user.type(s.getByLabelText('Your password'), 'alice-password'); // H1 step-up
    await user.click(s.getByRole('button', { name: 'Create token' }));

    // The once-shown raw token appears in the copyable field.
    await waitFor(() => {
      const field = s.getByLabelText('Agent token') as HTMLTextAreaElement;
      expect(field.value).toBe('dltos_agent_SECRET_1');
    });
    expect(s.queryByText(/won.t be able to see it again/i)).not.toBeNull();

    // POST carried the label.
    const postCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({
      label: 'Claude Code',
      password: 'alice-password',
    });
  });
});

// ── CC-R3 ───────────────────────────────────────────────────────────────────

describe('CC-R3 — copy writes the token to the clipboard', () => {
  it('Copy button calls navigator.clipboard.writeText with the raw token', async () => {
    const user = userEvent.setup();
    installFetchMock([]);
    await mountSettings();

    const s = section();
    await waitFor(() => expect(s.queryByText(/No connections yet/i)).not.toBeNull());

    await user.click(s.getByRole('button', { name: 'Generate token' }));
    await user.type(s.getByLabelText('Your password'), 'alice-password'); // H1 step-up
    await user.click(s.getByRole('button', { name: 'Create token' }));

    await waitFor(() => expect(s.queryByLabelText('Agent token')).not.toBeNull());
    await user.click(s.getByRole('button', { name: 'Copy token' }));

    // userEvent.setup() backs navigator.clipboard with an in-memory stub — read the token back out.
    await waitFor(() => expect(s.queryByText('Copied!')).not.toBeNull());
    expect(await navigator.clipboard.readText()).toBe('dltos_agent_SECRET_1');
  });
});

// ── CC-R4 ───────────────────────────────────────────────────────────────────

describe('CC-R4 — revoke removes the connection', () => {
  it('Revoke → Confirm → DELETE :grantId → row disappears', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetchMock([seed('Old token', 'g9')]);
    await mountSettings();

    const s = section();
    await waitFor(() => expect(s.queryByText('Old token')).not.toBeNull());

    await user.click(s.getByRole('button', { name: /Revoke Old token/i }));
    await user.click(s.getByRole('button', { name: /Confirm revoke Old token/i }));

    await waitFor(() => {
      expect(s.queryByText('Old token')).toBeNull();
    });

    const deleteCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCall).toBeDefined();
    expect(String(deleteCall![0])).toContain('/api/agent-tokens/g9');
  });
});

// ── CC-R5 ───────────────────────────────────────────────────────────────────

describe('CC-R5 — list load error', () => {
  it('renders an error message and a Retry button when the list call fails', async () => {
    installFetchMock([], { listStatus: 500 });
    await mountSettings();

    const s = section();
    await waitFor(() => {
      expect(s.queryByText(/Could not load connections/i)).not.toBeNull();
    });
    expect(s.queryByRole('button', { name: 'Retry' })).not.toBeNull();
  });
});

// ── CC-R6 ───────────────────────────────────────────────────────────────────

describe('CC-R6 — step-up rejection keeps the form (H1)', () => {
  it('a wrong password (401) shows the message inline, keeps the form, and mints no token', async () => {
    const user = userEvent.setup();
    installFetchMock([], { mintStatus: 401, mintErrorCode: 'password_invalid' });
    await mountSettings();

    const s = section();
    await waitFor(() => expect(s.queryByText(/No connections yet/i)).not.toBeNull());

    await user.click(s.getByRole('button', { name: 'Generate token' }));
    await user.type(s.getByLabelText('Your password'), 'wrong-password');
    await user.click(s.getByRole('button', { name: 'Create token' }));

    // Inline step-up error appears; the form (password field) is still up; NO token shown.
    await waitFor(() => expect(s.queryByText(/password is incorrect/i)).not.toBeNull());
    expect(s.queryByLabelText('Your password')).not.toBeNull();
    expect(s.queryByLabelText('Agent token')).toBeNull();
  });
});
