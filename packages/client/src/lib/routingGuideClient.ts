/**
 * Note-routing-guide client — the two owner-authed calls behind the "Note routing guide" Settings section.
 * The guide is a freeform text blob the owner edits; the MCP agent reads it (via `list_notebooks`) to decide
 * where to file saved notes. GET loads it, PUT saves it (empty/whitespace clears it → the server stores null).
 *
 * RESIDENCY: a LAZY off-track module — imported only by RoutingGuideSection, which rides the code-split
 * SettingsRoute chunk, so it never enters the mobile first-load bundle. The only shared import is the numeric
 * `ROUTING_GUIDE_MAX` constant (no zod runtime rides along).
 *
 * AUTH: every call bears the in-memory access token and, on a 401/403/503, re-mints the bearer ONCE from the
 * refresh cookie and retries — the SAME contract syncEngine.syncFetch / agentTokensClient use. The token is
 * read FRESH per request so it is never persisted at rest.
 */
import { useAuthStore } from '../auth/store.js';
import { ROUTING_GUIDE_MAX } from '@deltos/shared';

const BASE = '/api/account/routing-guide';

/** A failed routing-guide call, carrying the HTTP status (when the server responded) for the UI to message on. */
export class RoutingGuideError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'RoutingGuideError';
  }
}

function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().bearerToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * fetch() for a routing-guide call. Mirrors syncEngine.syncFetch / agentTokensClient: on an auth rejection
 * (403 = expired access token · 401 = defensive · 503 = absent-bearer cold-boot) it re-mints the in-memory
 * bearer ONCE and retries. A re-mint that can't restore a usable bearer surfaces a typed RoutingGuideError.
 */
async function authedFetch(init: RequestInit = {}): Promise<Response> {
  const send = () => fetch(BASE, { ...init, headers: { ...(init.headers ?? {}), ...authHeader() } });
  let res: Response;
  try {
    res = await send();
  } catch {
    throw new RoutingGuideError('Could not reach the server — check your connection.');
  }
  if (!(res.status === 401 || res.status === 403 || res.status === 503)) return res;
  const outcome = await useAuthStore.getState().remintBearer();
  if (outcome !== 'ok') {
    throw new RoutingGuideError(
      outcome === 'revoked'
        ? 'Your session expired — sign in again to edit settings.'
        : 'Could not reach the server — check your connection.',
      res.status,
    );
  }
  try {
    return await send();
  } catch {
    throw new RoutingGuideError('Could not reach the server — check your connection.');
  }
}

/** Load the current routing guide. `null` = unset (the textarea shows empty). */
export async function getRoutingGuide(): Promise<string | null> {
  const res = await authedFetch({ method: 'GET' });
  if (!res.ok) throw new RoutingGuideError(`Could not load the routing guide (${res.status}).`, res.status);
  const data = (await res.json()) as { routingGuide?: string | null };
  return data.routingGuide ?? null;
}

/**
 * Save the routing guide. Pass the raw text (or null to clear); the server normalizes empty/whitespace-only
 * to null and echoes back the stored value. A >8KB body is rejected (400) — surfaced as a typed error.
 */
export async function setRoutingGuide(guide: string | null): Promise<string | null> {
  const res = await authedFetch({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routingGuide: guide }),
  });
  if (res.status === 400) {
    throw new RoutingGuideError(`The guide is too long (max ${ROUTING_GUIDE_MAX} characters).`, 400);
  }
  if (!res.ok) throw new RoutingGuideError(`Could not save the routing guide (${res.status}).`, res.status);
  const data = (await res.json()) as { routingGuide?: string | null };
  return data.routingGuide ?? null;
}
