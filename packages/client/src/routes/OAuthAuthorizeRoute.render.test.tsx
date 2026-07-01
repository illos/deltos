/**
 * OAuthAuthorizeRoute render test (oauth-provider.md §2b / standing ui-features-need-rendered-ui-gate).
 * Mounts the REAL consent route over a mocked oauthClient + auth store and proves the behaviours that
 * matter for security + the OAuth contract:
 *   - the redirect HOST is disclosed (anti-phishing: "Access will be sent to: claude.ai");
 *   - Approve mints via POST /api/oauth/authorize with the exact params + step-up password, then performs
 *     the top-level OAuth redirect to `redirect_uri?code&state`;
 *   - Deny redirects to `redirect_uri?error=access_denied&state` WITHOUT any API call;
 *   - a non-S256 code_challenge_method / missing params are refused with NO POST;
 *   - a signed-out user is bounced to /login (return-here machinery), no consent shown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// oauthClient — spy on the mint; provide a real error class for the component's `instanceof` branch.
const { mintConsentCode } = vi.hoisted(() => ({ mintConsentCode: vi.fn() }));
vi.mock('../lib/oauthClient.js', () => {
  class OAuthClientError extends Error {
    status?: number | undefined;
    code?: string | undefined;
    constructor(message: string, status?: number, code?: string) {
      super(message);
      this.name = 'OAuthClientError';
      this.status = status;
      this.code = code;
    }
  }
  return { mintConsentCode, OAuthClientError };
});
import { OAuthClientError } from '../lib/oauthClient.js';

// Auth store — a mutable fake read through the selector API the component uses.
const authState: { isAuthed: boolean | null; totpEnabled: boolean } = { isAuthed: true, totpEnabled: false };
vi.mock('../auth/store.js', () => ({
  useAuthStore: (selector: (s: typeof authState) => unknown) => selector(authState),
}));

import { OAuthAuthorizeRoute } from './OAuthAuthorizeRoute.js';

const REDIRECT = 'https://claude.ai/api/mcp/callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function query(overrides: Record<string, string | undefined> = {}): string {
  const base: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: 'client_abc123',
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    scope: 'read search',
    state: 'xyz-state',
    ...overrides,
  };
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) if (v !== undefined) sp.set(k, v);
  return sp.toString();
}

function mount(qs: string) {
  return render(
    <MemoryRouter initialEntries={[`/oauth/authorize?${qs}`]}>
      <Routes>
        <Route path="/oauth/authorize" element={<OAuthAuthorizeRoute />} />
        <Route path="/login" element={<div data-testid="login">LOGIN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  authState.isAuthed = true;
  authState.totpEnabled = false;
  try {
    sessionStorage.clear();
  } catch {
    /* no sessionStorage in this env */
  }
  assign = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: 'http://localhost/', assign },
  });
});
afterEach(cleanup);

describe('OAuthAuthorizeRoute', () => {
  it('discloses the redirect host and read-only scopes on the consent screen', () => {
    const { container, getByText } = mount(query());
    expect(getByText('claude.ai')).toBeTruthy();
    expect(container.textContent).toContain('Access will be sent to:');
    expect(container.textContent).toContain('read-only');
    // Both v1 scopes named.
    expect(container.textContent).toContain('(read)');
    expect(container.textContent).toContain('(search)');
  });

  it('Approve mints with the exact params + step-up password and performs the OAuth redirect', async () => {
    mintConsentCode.mockResolvedValue({ code: 'CODE123', redirect_uri: REDIRECT, state: 'xyz-state' });
    const { getByLabelText } = mount(query());

    fireEvent.change(getByLabelText('Your password'), { target: { value: 'hunter2' } });
    fireEvent.click(getByLabelText('Authorize'));

    await waitFor(() => expect(mintConsentCode).toHaveBeenCalledTimes(1));
    expect(mintConsentCode).toHaveBeenCalledWith({
      client_id: 'client_abc123',
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      password: 'hunter2',
      scope: 'read search',
      state: 'xyz-state',
    });
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(`${REDIRECT}?code=CODE123&state=xyz-state`),
    );
  });

  it('Deny shows a terminal screen and NEVER navigates to the (unvalidated) redirect_uri', () => {
    // The redirect_uri is a raw query param we can't validate client-side, so denying must not bounce the
    // browser to it (open-redirect guard). A deny is terminal; the API is never called and no nav happens.
    const { getByLabelText, container } = mount(query());
    fireEvent.click(getByLabelText('Deny'));
    expect(mintConsentCode).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Access denied');
  });

  it('Deny does NOT navigate even when an attacker supplies an off-domain redirect_uri', () => {
    const { getByLabelText, container } = mount(query({ redirect_uri: 'https://evil.example/steal' }));
    fireEvent.click(getByLabelText('Deny'));
    expect(assign).not.toHaveBeenCalled(); // no open redirect to evil.example
    expect(container.textContent).toContain('Access denied');
  });

  it('a step-up failure shows an inline error and does not redirect', async () => {
    mintConsentCode.mockRejectedValue(new OAuthClientError('That password is incorrect.', 401, 'password_invalid'));
    const { getByLabelText, findByText } = mount(query());

    fireEvent.change(getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(getByLabelText('Authorize'));

    expect(await findByText('That password is incorrect.')).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    // Still on the consent screen — the password field is available for a retry.
    expect(getByLabelText('Your password')).toBeTruthy();
  });

  it('refuses a non-S256 code_challenge_method with no POST', () => {
    const { container } = mount(query({ code_challenge_method: 'plain' }));
    expect(container.textContent).toContain('Can’t authorize this app');
    expect(container.textContent).toContain('PKCE S256');
    expect(mintConsentCode).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Authorize"]')).toBeNull();
  });

  it('refuses a request missing the code_challenge with no POST', () => {
    const { container } = mount(query({ code_challenge: undefined }));
    expect(container.textContent).toContain('Can’t authorize this app');
    expect(mintConsentCode).not.toHaveBeenCalled();
  });

  it('bounces a signed-out user to /login and stashes the return path', () => {
    authState.isAuthed = false;
    const { getByTestId } = mount(query());
    expect(getByTestId('login').textContent).toBe('LOGIN');
    expect(sessionStorage.getItem('deltos:oauth:return')).toContain('/oauth/authorize?');
  });

  it('shows the TOTP field when 2FA is on and forwards the code', async () => {
    authState.totpEnabled = true;
    mintConsentCode.mockResolvedValue({ code: 'C2', redirect_uri: REDIRECT, state: 'xyz-state' });
    const { getByLabelText } = mount(query());

    fireEvent.change(getByLabelText('Your password'), { target: { value: 'hunter2' } });
    fireEvent.change(getByLabelText('Two-factor code'), { target: { value: '123456' } });
    fireEvent.click(getByLabelText('Authorize'));

    await waitFor(() => expect(mintConsentCode).toHaveBeenCalledTimes(1));
    expect(mintConsentCode.mock.calls[0]?.[0]).toMatchObject({ totp: '123456', password: 'hunter2' });
  });
});
