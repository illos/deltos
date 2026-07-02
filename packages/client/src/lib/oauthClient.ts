/**
 * OAuth-provider client — the owner-authed calls behind the "Connected apps" Settings section
 * (docs/design/oauth-provider.md §4): list the OAuth-issued grants and disconnect an app (revoke every
 * grant for a client). deltos is its own MCP Authorization Server. NOTE: the consent MINT is NOT here — it
 * lives on the SEPARATE OAuth authorization surface (src/oauth/surfaceApi.ts), decoupled from this app
 * (oauth-consent-surface-separation.md / DEC-0005).
 *
 * RESIDENCY (CONV-0004 / plugins-lazy-past-first-paint): this is a LAZY off-track module, imported only by
 * `ConnectedAppsSection` (rides the already code-split SettingsRoute chunk), so it never enters the mobile
 * first-load bundle. Shared types come in `import type`-only (erased at build) — no zod tags along.
 *
 * AUTH: every call bears the in-memory access token (auth/store) and, on an auth rejection (403 = expired
 * access token · 401 = defensive · 503 = absent-bearer cold-boot), re-mints the bearer ONCE from the refresh
 * cookie and retries — the SAME contract syncEngine/agentTokensClient use.
 */
import { useAuthStore } from '../auth/store.js';
import type { ConnectedApp, ListConnectedAppsResponse } from '@deltos/shared';

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
 * fetch() for an OAuth-provider management call. Mirrors agentTokensClient.authedFetch: on an auth rejection
 * (403 = expired access token · 401 = defensive · 503 = absent-bearer cold-boot) it re-mints the in-memory
 * bearer ONCE from the refresh cookie and retries.
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...authHeader() } });
  let res: Response;
  try {
    res = await send();
  } catch {
    throw new OAuthClientError('Could not reach the server — check your connection.');
  }
  const authReject = res.status === 401 || res.status === 403 || res.status === 503;
  if (!authReject) return res;
  const outcome = await useAuthStore.getState().remintBearer();
  if (outcome !== 'ok') {
    throw new OAuthClientError(
      outcome === 'revoked'
        ? 'Your session expired — sign in again to continue.'
        : 'Could not reach the server — check your connection.',
      res.status,
      // The consent screen keys on this code to route into a full re-login (vs a step-up retry).
      outcome === 'revoked' ? 'session_revoked' : 'network_error',
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
