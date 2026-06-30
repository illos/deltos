/**
 * ROAD-0005 P4 — denial-of-wallet charging (Tier 2). `chargeUsage` atomically bumps the durable per-account
 * per-UTC-day counter for a cost-bearing metric and reports whether the account is still under its daily
 * cap. Routes call it on the COST-bearing path and 429 (`quotaExceeded`) when over.
 *
 * SEPARATION OF DUTIES: like `audit.ts`, this lives in the request-context layer and builds its store from
 * `c.env.DB` — it is NOT part of the data layer (`db/*`, `mutate.ts`), which takes its `DbAdapter` by arg and
 * never touches `c.env`. The counters share the `DB` (not the append-only AUDIT dataset), so this is a normal
 * D1 write, not a touch of the tamper-proof audit log.
 *
 * Fail-CLOSED is the right posture here (unlike the Tier-1 coarse rate ceiling, which fails open): this IS
 * the cost guard, so if its D1 write throws the request fails anyway — there is no "allow on error" that
 * doesn't also re-open the denial-of-wallet hole.
 */
import { createAuthStore } from './db/authStore.js';
import { d1Adapter } from './db/schema.js';
import { apiError, type AppContext } from './http.js';
import { DAILY_QUOTA, dayBucket, type UsageMetric } from './abusePolicy.js';

export interface UsageDecision {
  allowed: boolean;
  count: number;
  cap: number;
  metric: UsageMetric;
}

/**
 * Charge one unit of `metric` to `accountId` for the current UTC day. Returns `allowed:false` (without
 * charging) once the day's budget is spent. `accountId` MUST be the server-derived account (never a body
 * field) so the cap is BOLA-safe.
 */
export async function chargeUsage(
  c: AppContext,
  accountId: string,
  metric: UsageMetric,
): Promise<UsageDecision> {
  const cap = DAILY_QUOTA[metric];
  const nowMs = Date.now();
  const store = createAuthStore(d1Adapter(c.env.DB));
  const { allowed, count } = await store.chargeUsage(
    accountId,
    metric,
    dayBucket(nowMs),
    cap,
    new Date(nowMs).toISOString(),
  );
  return { allowed, count, cap, metric };
}

/** The 429 a route returns when `chargeUsage` denies. Resets at UTC midnight when the day bucket rolls. */
export function quotaExceeded(c: AppContext, d: UsageDecision): Response {
  return apiError(
    c,
    429,
    'quota_exceeded',
    `daily ${d.metric} quota reached (${d.cap}/day); resets at UTC midnight`,
  );
}
