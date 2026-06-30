/**
 * Account-activity client — the single owner-authed read behind the "Account activity" Settings section
 * (ROAD-0005 P3, the user-facing audit view). Lists the account's recent security events so the owner can
 * self-audit anytime and catch anomalous access live (a sign-in from nowhere, a connected app reading more
 * than expected, a token they didn't create).
 *
 * RESIDENCY: a LAZY off-track-route module — imported only by ActivitySection, which rides the already
 * code-split SettingsRoute chunk, so it never enters the mobile first-load bundle. Contract types are
 * declared inline (the backend is the schema-first source of truth; these are read-only views the UI casts
 * the response into) — the same convention as sessionsClient.
 *
 * AUTH: bears the in-memory access token and, on a 401/403/503, re-mints the bearer ONCE from the refresh
 * cookie and retries — the SAME contract as sessionsClient / syncEngine.syncFetch. The token is read FRESH
 * per request so it is never persisted at rest (F7).
 */
import { useAuthStore } from '../auth/store.js';

const BASE = '/api/audit';

/** One security event in the account's activity feed. Carries non-secret metadata only (never a token). */
export interface ActivityEvent {
  /** Stable id (the projection row id) — a React key + ordering anchor. */
  id: number;
  /** ISO-8601 timestamp the event occurred. */
  ts: string;
  /** Which surface produced it: 'auth' (sign-in / credential lifecycle) · 'mcp' (a connected AI) · 'rest'. */
  surface: string;
  /** The operation/action: 'login' · 'token.mint' · 'session.revoke' · the grant op for access events. */
  action: string;
  /** 'allow' (it happened) or 'deny' (it was refused — a failed/blocked attempt). */
  result: string;
  /** Who acted: 'owner' (you) · 'agent' (a connected app like Claude) · 'anonymous' (an unauthed attempt). */
  principalKind: string;
  /** The targeted resource kind, when the event has one. */
  resourceKind: string | null;
  /** The targeted resource id, when scoped to a specific notebook/note. */
  resourceId: string | null;
  /** The client IP at the time, when known. */
  ip: string | null;
  /** The country (Cloudflare geo) at the time, when known. */
  country: string | null;
  /** Freeform extra: a denial reason, the MCP tool name, the revoked grant/family id, etc. */
  detail: string | null;
}

interface RecentResponse {
  events: ActivityEvent[];
}

/** A failed activity call, carrying the HTTP status (when the server responded) for the UI to message on. */
export class ActivityError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ActivityError';
  }
}

function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().bearerToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** fetch() for an activity call — re-mints the in-memory bearer ONCE on an auth rejection, then retries. */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...authHeader() } });
  let res: Response;
  try {
    res = await send();
  } catch {
    throw new ActivityError('Could not reach the server — check your connection.');
  }
  if (res.status !== 401 && res.status !== 403 && res.status !== 503) return res;
  const outcome = await useAuthStore.getState().remintBearer();
  if (outcome !== 'ok') {
    throw new ActivityError(
      outcome === 'revoked'
        ? 'Your session expired — sign in again to view activity.'
        : 'Could not reach the server — check your connection.',
      res.status,
    );
  }
  try {
    return await send();
  } catch {
    throw new ActivityError('Could not reach the server — check your connection.');
  }
}

/** List the caller's recent account activity, newest-first. */
export async function listRecentActivity(): Promise<ActivityEvent[]> {
  const res = await authedFetch('/recent', { method: 'GET' });
  if (!res.ok) throw new ActivityError(`Could not load activity (${res.status}).`, res.status);
  const data = (await res.json()) as Partial<RecentResponse>;
  return Array.isArray(data.events) ? data.events : [];
}
