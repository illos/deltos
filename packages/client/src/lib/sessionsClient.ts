/**
 * Sessions client — the three owner-authed calls behind the "Active sessions" Settings section
 * (Phase-2 credential lifecycle). Lists the account's active login sessions and revokes them: a single
 * session (the kill-switch for a lost/stolen device) or every OTHER session at once.
 *
 * RESIDENCY: this is a LAZY off-track-route module — it is imported only by SessionsSection, which rides
 * the already code-split SettingsRoute chunk, so it never enters the mobile first-load bundle. The
 * contract types are declared inline (the backend is the schema-first source of truth; the shapes here
 * are read-only views the UI casts the response into — no zod tags along), matching the auth store's
 * "cast the response shape" convention.
 *
 * AUTH: every call bears the in-memory access token (auth/store) and, on a 401/403/503, re-mints the
 * bearer ONCE from the refresh cookie and retries — the SAME contract syncEngine.syncFetch and
 * agentTokensClient use. The token is read FRESH per request so it is never persisted at rest (F7).
 */
import { useAuthStore } from '../auth/store.js';

const BASE = '/api/auth/sessions';

/** A login session — one credential family (a sign-in on a device). The response never includes a secret. */
export interface LoginSession {
  /** Stable id of the refresh-token family backing this session. The unit of revocation. */
  familyId: string;
  /** A human label for the session (device / sign-in), or null when the server has none. */
  label: string | null;
  /** ISO-8601 timestamp the session was created (first sign-in on this device). */
  createdAt: string;
  /** True for the session making the request — the device the user is looking at the screen on. */
  current: boolean;
}

interface ListSessionsResponse {
  sessions: LoginSession[];
}

interface SignOutOthersResponse {
  revoked: number;
}

/** A failed sessions call, carrying the HTTP status (when the server responded) for the UI to message on. */
export class SessionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().bearerToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * fetch() for a sessions call. Mirrors syncEngine.syncFetch / agentTokensClient: on an auth rejection
 * (403 = expired access token · 401 = defensive · 503 = absent-bearer cold-boot) it re-mints the in-memory
 * bearer ONCE and retries. A re-mint that can't restore a usable bearer ('revoked'/'offline') surfaces a
 * typed SessionError.
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...authHeader() } });
  let res: Response;
  try {
    res = await send();
  } catch {
    throw new SessionError('Could not reach the server — check your connection.');
  }
  if (res.status !== 401 && res.status !== 403 && res.status !== 503) return res;
  const outcome = await useAuthStore.getState().remintBearer();
  if (outcome !== 'ok') {
    throw new SessionError(
      outcome === 'revoked'
        ? 'Your session expired — sign in again to manage sessions.'
        : 'Could not reach the server — check your connection.',
      res.status,
    );
  }
  try {
    return await send();
  } catch {
    throw new SessionError('Could not reach the server — check your connection.');
  }
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** List the caller's active login sessions. The `current` flag marks the device making the request. */
export async function listSessions(): Promise<LoginSession[]> {
  const res = await authedFetch('', { method: 'GET' });
  if (!res.ok) throw new SessionError(`Could not load sessions (${res.status}).`, res.status);
  const data = await readJson<Partial<ListSessionsResponse>>(res);
  return Array.isArray(data.sessions) ? data.sessions : [];
}

/**
 * Revoke one login session by familyId, signing out that device immediately. The server returns 404 for
 * not-found / already-revoked / not-owned (no cross-account disclosure) — all benign for a revoke, so we
 * treat 404 as success and simply drop the row. Any other non-OK is a real failure.
 */
export async function revokeSession(familyId: string): Promise<void> {
  const res = await authedFetch(`/${encodeURIComponent(familyId)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new SessionError(`Could not sign out that session (${res.status}).`, res.status);
  }
}

/**
 * Sign out every OTHER session, keeping the current one. The server keeps the caller's own session by
 * construction — this never touches the device making the request. Returns the number revoked.
 */
export async function signOutOthers(): Promise<number> {
  const res = await authedFetch('/signout-others', { method: 'POST' });
  if (!res.ok) throw new SessionError(`Could not sign out other sessions (${res.status}).`, res.status);
  const data = await readJson<Partial<SignOutOthersResponse>>(res);
  return typeof data.revoked === 'number' ? data.revoked : 0;
}
