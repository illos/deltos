/**
 * ROAD-0005 P4 — abuse & cost-control POLICY. The tunable ceilings for the two-tier defense, kept in one
 * place (siblings of `authPolicy.ts`) so the numbers can be tuned without hunting through route code.
 *
 * TWO TIERS, by what each can actually enforce:
 *
 *  - **Tier 1 — coarse request-RATE ceiling** (`env.API_RATE_LIMITER`, the native Workers rate-limit
 *    binding, wired in wrangler.jsonc). Per-principal, per-colo, eventually-consistent, fail-OPEN. It
 *    cheaply stops a runaway loop / flood on the authenticated surface WITHOUT touching D1 (so the hot
 *    sync path keeps its load-feel). It is NOT an accurate accountant and NOT a security invariant — by
 *    CF's own description — so it can never be the cost cap. See `rateLimit.ts#principalRateAllow`.
 *
 *  - **Tier 2 — durable cumulative SPEND cap** (the D1 `usageCounter` table, migration 0016). Per-account,
 *    per-UTC-day, global, fail-CLOSED on the COST-bearing endpoints. This is the real denial-of-wallet
 *    guard: once an account spends its daily budget on a paid path, further calls 429 until the day rolls.
 *    See `usage.ts#chargeUsage`.
 *
 * Calibration: only Jim holds a credential today, so these are generous (they stop abuse/runaways, never
 * legitimate solo use) and are HARD prerequisites before a 2nd user — exactly the deferral the transcribe
 * (§6 @c1210fc), unfurl, and blob route comments flagged but did not waive.
 */

/** A cost-bearing endpoint metered by the durable Tier-2 daily cap. */
export type UsageMetric = 'transcribe' | 'unfurl' | 'blobWrite' | 'mcp' | 'mcpWrite';

/**
 * Per-account, per-UTC-day call ceilings for each cost-bearing metric (Tier 2). Reaching the cap →
 * HTTP 429 until the day rolls. Generous for solo dogfood; tune down (or split into per-minute + per-day)
 * as real usage data arrives. Each call is one unit; size/cost caps stay enforced per-call at the routes
 * (e.g. transcribe MAX_AUDIO_*, blob MAX_BLOB_SIZE / ACCOUNT_BLOB_QUOTA).
 */
export const DAILY_QUOTA: Record<UsageMetric, number> = {
  transcribe: 1000, // Workers AI Whisper calls/account/day (paid inference)
  unfurl: 2000, // server-side link fetches/account/day (paid egress; KV-cached re-fetch of same URL is cheap)
  blobWrite: 2000, // R2 blob put/presign operations/account/day (write churn)
  mcp: 50_000, // MCP tool calls/account/day — a ceiling ABOVE the per-token 600/min window, bounding total daily spend across all of an account's tokens
  mcpWrite: 100, // MCP WRITE tool calls/account/day (write-tools.md §7) — a LOW blast-radius cap far below the read ceiling, so an injection-driven write flood is bounded to a handful of individually-recoverable writes
};

/**
 * Tier-1 coarse per-principal request-rate ceiling for the authenticated REST/sync surface (`guard()`).
 * Documents the intent; the ENFORCED numbers live in wrangler.jsonc `ratelimits` (the binding owns the
 * window). Generous vs. legitimate sync cadence (~push 2s + pull 2s ≈ 30 req/min) with wide headroom for
 * multi-tab / catch-up bursts; it only bites a runaway client. period ∈ {10, 60}s (binding constraint).
 */
export const API_RATE_CEILING = { limit: 200, periodSec: 10 } as const; // 200 / 10s ≈ 1200/min per principal per colo

/**
 * Retention windows for the scheduled prune (`index.ts#scheduled` → cron). The append-only AE dataset is
 * the forensic truth and is NOT pruned here; these bound only the D1 mirrors so they stay small + cheap.
 */
export const AUDIT_LOG_RETENTION_DAYS = 90; // user-facing "Account activity" mirror horizon
export const USAGE_COUNTER_RETENTION_DAYS = 7; // daily counters only need a few days of tail for inspection
// OAuth clients (DCR): drop a registered client with NO live grant after this many days — bounds DCR-spam
// row growth (the /register rate-limit fails open, so this is the durable backstop). A client with any live
// grant is kept regardless of age. Auth codes are pruned separately (60s TTL, every cron pass).
export const OAUTH_CLIENT_RETENTION_DAYS = 30;

/** The UTC day bucket ('YYYY-MM-DD') a timestamp falls in — the partition key for the daily quota. */
export function dayBucket(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
