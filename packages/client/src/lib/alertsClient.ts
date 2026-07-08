/**
 * alertsClient — the owner-authed Approve/Deny call behind the AlertBanner's actionable alerts
 * (alert-banner-system.md §6.4). POSTs `{ actionId }` to the generic action endpoint; the server dispatches
 * on the OWNED row's `targetKind`, CAS-mutates, audits, and lifts the write quota on approve. The client
 * never interprets `targetId` — it just names the alert by id in the URL and echoes the chosen `actionId`.
 *
 * RESIDENCY: the banner strip's inline Approve/Deny needs this, so it rides the entry-adjacent AlertBanner;
 * it is a thin fetch module (no zod runtime — `import type` only), matching alertStore's entry-safety.
 *
 * AUTH: the SAME contract as agentTokensClient.authedFetch / syncEngine.syncFetch — bear the in-memory
 * access token read FRESH per request (never persisted, F7); on a 401/403/503 re-mint the bearer ONCE from
 * the refresh cookie and retry. A re-mint that can't restore a usable bearer surfaces a typed AlertActionError.
 */
import { useAuthStore } from '../auth/store.js';
import type { AlertActionRequest } from '@deltos/shared';

const BASE = '/api/alerts';

/** Outcome shape the server returns on a successful action (fields absent for deny). Cast, not parsed. */
export interface AlertActionResult {
  id: string;
  status: 'approved' | 'denied' | 'pending' | 'expired';
  grantedCount?: number;
  windowDayBucket?: string;
}

/**
 * A failed alert action, carrying the HTTP status. `alreadyResolved` (409) is called out so the banner can
 * clear the stale alert without treating it as an error (the request was acted on elsewhere / expired).
 */
export class AlertActionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** True when the server said the request is already resolved/expired (409) — a benign, clearable state. */
    readonly alreadyResolved = false,
  ) {
    super(message);
    this.name = 'AlertActionError';
  }
}

function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().bearerToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** fetch() for an alert-action call — mirrors agentTokensClient.authedFetch (re-mint-once-then-retry). */
async function authedFetch(path: string, init: RequestInit): Promise<Response> {
  const send = () =>
    fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...authHeader() } });
  let res: Response;
  try {
    res = await send();
  } catch {
    throw new AlertActionError('Could not reach the server — check your connection.');
  }
  const authReject = res.status === 401 || res.status === 403 || res.status === 503;
  if (!authReject) return res;
  const outcome = await useAuthStore.getState().remintBearer();
  if (outcome !== 'ok') {
    throw new AlertActionError(
      outcome === 'revoked'
        ? 'Your session expired — sign in again.'
        : 'Could not reach the server — check your connection.',
      res.status,
    );
  }
  try {
    return await send();
  } catch {
    throw new AlertActionError('Could not reach the server — check your connection.');
  }
}

/**
 * Approve or Deny an actionable alert. On success the server resolves the request so it stops projecting on
 * the next sync-pull; the caller may also optimistically drop it from the store. A 409 (already resolved /
 * expired) throws an AlertActionError with `alreadyResolved: true` — the caller should clear the stale alert,
 * NOT surface an error. Any other non-OK throws with the status.
 */
export async function actOnAlert(alertId: string, actionId: 'approve' | 'deny'): Promise<AlertActionResult> {
  const body: AlertActionRequest = { actionId };
  const res = await authedFetch(`/${encodeURIComponent(alertId)}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    throw new AlertActionError('This request was already resolved.', 409, true);
  }
  if (!res.ok) {
    throw new AlertActionError(`Could not complete that action (${res.status}).`, res.status);
  }
  return (await res.json()) as AlertActionResult;
}
