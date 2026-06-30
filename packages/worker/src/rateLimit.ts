import type { AuthStore } from './db/authStore.js';
import type { Env } from './env.js';

/**
 * Tier-1 coarse per-principal request-rate ceiling over the native Workers rate-limit binding
 * (`env.API_RATE_LIMITER`, configured in wrangler.jsonc; ROAD-0005 P4). One in-memory edge call, NO D1
 * write — so it can sit on the hot REST/sync chokepoint (`guard()`) without regressing load-feel.
 *
 * FAIL-OPEN by design: this is a coarse abuse/DoS ceiling, NOT a security invariant and NOT the cost cap
 * (the durable D1 `usageCounter`, `usage.ts`, is the hard denial-of-wallet guard). The binding is per-colo
 * + eventually-consistent ("intentionally not an accurate accounting system" — CF docs); letting an
 * unbound binding (tests) or a transient limiter error through is correct — it must never block legitimate
 * traffic. Returns true (allow) when the binding is absent or throws.
 */
export async function principalRateAllow(
  limiter: Env['API_RATE_LIMITER'],
  key: string,
): Promise<boolean> {
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}

/**
 * Fixed-window request rate-limit over the `authThrottle` store, reused as a counter (ROAD-0005 P0 item C):
 * allow up to `limit` requests per `windowMs` per bucket. Returns true if the request is allowed (and
 * records the hit), false once the window's budget is spent. A coarse abuse/cost ceiling for authenticated
 * API surfaces (e.g. the MCP endpoint, keyed per-token) — NOT a security invariant.
 *
 * The `authThrottle` row is repurposed: `failures` holds the window's running count and `nextAllowedMs`
 * holds the window-end instant. The first request of a new/expired window resets both.
 */
export async function fixedWindowAllow(
  store: AuthStore,
  bucket: string,
  limit: number,
  windowMs: number,
  nowMs: number,
): Promise<boolean> {
  const rec = await store.getThrottle(bucket);
  const at = new Date(nowMs).toISOString();
  if (!rec || nowMs >= rec.nextAllowedMs) {
    await store.recordThrottleFailure(bucket, 1, nowMs + windowMs, at); // start a fresh window
    return true;
  }
  if (rec.failures >= limit) {
    // Already at the ceiling for this window — deny WITHOUT another write, so a flood neither amplifies
    // D1 writes nor grows the counter unboundedly. It self-resets at window roll-over (branch above).
    return false;
  }
  const count = rec.failures + 1;
  await store.recordThrottleFailure(bucket, count, rec.nextAllowedMs, at);
  return count <= limit;
}
