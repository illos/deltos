/**
 * OAuthApp render test (oauth-consent-surface-separation.md / standing ui-features-need-rendered-ui-gate).
 * Mounts the REAL separate-surface consent app over a mocked surfaceApi and proves the full flow:
 *   - invalid params (missing client_id) → a terminal error, and refresh is never attempted;
 *   - a live refresh session → the consent disclosure (redirect HOST + client id + read-only scopes), and
 *     Approve mints the code (bearer + step-up password) then top-level-redirects to redirect_uri?code&state;
 *   - no session → the inline login; a successful login carries the password so consent needs no re-entry;
 *   - Deny → a terminal "Access denied" screen (never navigates the redirect_uri).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

const { refreshBearer, login, mintConsentCode } = vi.hoisted(() => ({
  refreshBearer: vi.fn(),
  login: vi.fn(),
  mintConsentCode: vi.fn(),
}));
vi.mock('./surfaceApi.js', () => {
  class ConsentError extends Error {
    status?: number | undefined;
    code?: string | undefined;
    constructor(message: string, status?: number, code?: string) {
      super(message);
      this.name = 'ConsentError';
      this.status = status;
      this.code = code;
    }
  }
  return { refreshBearer, login, mintConsentCode, ConsentError };
});

import { OAuthApp } from './OAuthApp.js';

const VALID =
  'client_id=client_abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&code_challenge=xyz123&code_challenge_method=S256&state=st1';

// jsdom's window.location.assign can't be spied (non-configurable), so replace window.location with a minimal
// stub carrying the query string the component parses + a mockable assign() (the OAuth redirect).
let assignMock: ReturnType<typeof vi.fn>;
function setSearch(q: string) {
  assignMock = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      href: `http://localhost/oauth/authorize?${q}`,
      origin: 'http://localhost',
      pathname: '/oauth/authorize',
      search: `?${q}`,
      hash: '',
      assign: assignMock,
      replace: vi.fn(),
    },
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('OAuthApp (separate consent surface)', () => {
  it('refuses an invalid request before touching the network', async () => {
    // Missing client_id → parse fails; the effect must NOT call refreshBearer.
    setSearch('redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&code_challenge=x&code_challenge_method=S256');
    const { findByText } = render(<OAuthApp />);
    expect(await findByText(/Can’t authorize this app/)).toBeTruthy();
    expect(refreshBearer).not.toHaveBeenCalled();
  });

  it('shows the consent disclosure and mints + redirects on Approve (refresh session)', async () => {
    setSearch(VALID);
    refreshBearer.mockResolvedValue({ bearer: 'b1', totpEnabled: false });
    mintConsentCode.mockResolvedValue({ code: 'authcode', redirect_uri: 'https://claude.ai/cb', state: 'st1' });

    const { findByText, getByLabelText, container } = render(<OAuthApp />);

    await findByText('Authorize access to your notes');
    // Anti-phishing disclosure: named by the redirect HOST + client id, read-only scopes.
    expect(container.textContent).toContain('claude.ai');
    expect(container.textContent).toContain('client_abc');
    expect(container.textContent).toContain('read-only');

    // Refresh path → the step-up password is collected here (no carried login password).
    fireEvent.change(getByLabelText('Your password'), { target: { value: 'pw' } });
    fireEvent.click(getByLabelText('Authorize'));

    await waitFor(() => expect(mintConsentCode).toHaveBeenCalled());
    expect(mintConsentCode.mock.calls[0]?.[0]).toBe('b1');
    expect(mintConsentCode.mock.calls[0]?.[1]).toMatchObject({
      client_id: 'client_abc',
      redirect_uri: 'https://claude.ai/cb',
      code_challenge_method: 'S256',
      password: 'pw',
      state: 'st1',
    });
    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith(expect.stringContaining('code=authcode')),
    );
  });

  it('falls to inline login when there is no session, then reuses the password at consent', async () => {
    setSearch(VALID);
    refreshBearer.mockResolvedValue(null);
    login.mockResolvedValue({ ok: true, session: { bearer: 'b2', totpEnabled: false } });
    mintConsentCode.mockResolvedValue({ code: 'c2', redirect_uri: 'https://claude.ai/cb' });

    const { findByText, getByText, getByLabelText, queryByLabelText } = render(<OAuthApp />);

    await findByText('Sign in to authorize');
    fireEvent.change(getByLabelText('Username'), { target: { value: 'jim' } });
    fireEvent.change(getByLabelText('Password'), { target: { value: 'pw2' } });
    fireEvent.click(getByText('Sign in'));

    await waitFor(() => expect(login).toHaveBeenCalledWith('jim', 'pw2', undefined, undefined));
    // Consent renders; the login password was carried → no password field is shown.
    await findByText('Authorize access to your notes');
    expect(queryByLabelText('Your password')).toBeNull();

    fireEvent.click(getByLabelText('Authorize'));
    await waitFor(() =>
      expect(mintConsentCode).toHaveBeenCalledWith('b2', expect.objectContaining({ password: 'pw2' })),
    );
  });

  it('Deny is a terminal screen and never navigates the redirect_uri', async () => {
    setSearch(VALID);
    refreshBearer.mockResolvedValue({ bearer: 'b1', totpEnabled: false });

    const { findByText, getByLabelText } = render(<OAuthApp />);
    await findByText('Authorize access to your notes');
    fireEvent.click(getByLabelText('Deny'));

    expect(await findByText('Access denied')).toBeTruthy();
    expect(assignMock).not.toHaveBeenCalled();
    expect(mintConsentCode).not.toHaveBeenCalled();
  });
});
