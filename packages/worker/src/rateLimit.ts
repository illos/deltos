import type { AuthStore } from './db/authStore.js';

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
  const count = rec.failures + 1;
  await store.recordThrottleFailure(bucket, count, rec.nextAllowedMs, at);
  return count <= limit;
}
