/**
 * OAuth-provider client — the owner-authed calls behind the OAuth consent screen and the "Connected apps"
 * Settings section (docs/design/oauth-provider.md §2b / §4). deltos is its own MCP Authorization Server;
 * these three calls mint an authorization code at consent, list the OAuth-issued grants, and disconnect an
 * app (revoke every grant for a client).
 *
 * RESIDENCY (CONV-0004 / plugins-lazy-past-first-paint): this is a LAZY off-track module. It is imported
 * only by `OAuthAuthorizeRoute` (its own lazy route chunk) and `ConnectedAppsSection` (rides the already
 * code-split SettingsRoute chunk), so it never enters the mobile first-load bundle. Shared types come in
 * `import type`-only (erased at build) — no zod tags along; mirrors `agentTokensClient`.
 *
 * AUTH: every call bears the in-memory access token (auth/store) and, on an auth rejection, re-mints the
 * bearer ONCE from the refresh cookie and retries — the SAME contract syncEngine/agentTokensClient use.
 * The consent MINT is the exception: a 401 there is a STEP-UP failure (wrong/missing password or TOTP),
 * NOT an expired bearer, so it must NOT be swallowed by a silent re-mint + retry (a 403 = expired access
 * token is; a 503 = absent-bearer cold-boot is).
 */
import { useAuthStore } from '../auth/store.js';
import type {
  AuthorizeConsentRequest,
  AuthorizeConsentResponse,
  ConnectedApp,
  ListConnectedAppsResponse,
} from '@deltos/shared';

const BASE = '/api/oauth';

/** A failed OAuth call, carrying the HTTP status + server error code (for step-up field targeting). */
export class OAuthClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'OAuthClientError';
  }
}

function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().bearerToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * fetch() for an OAuth call. Mirrors agentTokensClient.authedFetch: on an auth rejection (403 = expired
 * access token · 401 = defensive · 503 = absent-bearer cold-boot) it re-mints the in-memory bearer ONCE and
 * retries. The consent mint passes `remintOn401:false` so a step-up rejection (401) is surfaced, not masked
 * as a session expiry.
 */
async function authedFetch(
  path: string,
  init: RequestInit = {},
  opts: { remintOn401?: boolean } = {},
): Promise<Response> {
  const remintOn401 = opts.remintOn401 ?? true;
  const send = () =>
    fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...authHeader() } });
  let res: Response;
  try {
    res = await send();
  } catch {
    throw new OAuthClientError('Could not reach the server — check your connection.');
  }
  const authReject = (res.status === 401 && remintOn401) || res.status === 403 || res.status === 503;
  if (!authReject) return res;
  const outcome = await useAuthStore.getState().remintBearer();
  if (outcome !== 'ok') {
    throw new OAuthClientError(
      outcome === 'revoked'
        ? 'Your session expired — sign in again to continue.'
        : 'Could not reach the server — check your connection.',
      res.status,
    );
  }
  try {
    return await send();
  } catch {
    throw new OAuthClientError('Could not reach the server — check your connection.');
  }
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Turn a step-up error code (or none) into a human message keyed to the field at fault. */
function stepUpMessage(code?: string): string {
  switch (code) {
    case 'password_required':
      return 'Enter your password to authorize this app.';
    case 'password_invalid':
      return 'That password is incorrect.';
    case 'totp_required':
      return 'Enter your two-factor code.';
    case 'totp_invalid':
      return 'That two-factor code is not valid.';
    default:
      return 'Re-authentication failed — check your password and try again.';
  }
}

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

/**
 * Mint the OAuth authorization code at consent (POST /api/oauth/authorize). Bearer-authed + STEP-UP
 * (`password` always; `totp` when 2FA is on) — the server re-proves the human, exactly like agent-token
 * mint. On success returns `{ code, redirect_uri, state? }`; the caller then navigates the browser to
 * `redirect_uri?code&state` (that top-level navigation IS the OAuth redirect). A step-up failure surfaces as
 * an OAuthClientError(status 401, code) so the screen can target the right field and let the user retry.
 * A 400 means the app's request is invalid (unknown client / unregistered redirect) — a config error, not a
 * retryable step-up.
 */
export async function mintConsentCode(
  params: AuthorizeConsentRequest,
): Promise<AuthorizeConsentResponse> {
  const res = await authedFetch(
    '/authorize',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) },
    { remintOn401: false },
  );
  if (res.status === 401) {
    const code = await readErrorCode(res);
    throw new OAuthClientError(stepUpMessage(code), 401, code);
  }
  if (res.status === 400) {
    throw new OAuthClientError(
      'This app’s authorization request is invalid — it may be misconfigured.',
      400,
    );
  }
  if (res.status === 429) {
    throw new OAuthClientError('Too many attempts — wait a moment and try again.', 429);
  }
  if (!res.ok) throw new OAuthClientError(`Could not authorize the app (${res.status}).`, res.status);
  return readJson<AuthorizeConsentResponse>(res);
}

/** List the account's connected OAuth apps (grants). The response never includes a token or hash. */
export async function listConnectedApps(): Promise<ConnectedApp[]> {
  const res = await authedFetch('/clients', { method: 'GET' });
  if (!res.ok) throw new OAuthClientError(`Could not load connected apps (${res.status}).`, res.status);
  const data = await readJson<Partial<ListConnectedAppsResponse>>(res);
  return Array.isArray(data.apps) ? data.apps : [];
}

/**
 * Disconnect an app by clientId — revokes every OAuth grant this account holds for that client. The server
 * returns 404 for not-found / already-revoked / not-owned (no cross-account disclosure) — all benign for a
 * disconnect, so we treat 404 as success and simply drop the group. Any other non-OK is a real failure.
 */
export async function disconnectApp(clientId: string): Promise<void> {
  const res = await authedFetch(`/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new OAuthClientError(`Could not disconnect the app (${res.status}).`, res.status);
  }
}

export type { ConnectedApp };
