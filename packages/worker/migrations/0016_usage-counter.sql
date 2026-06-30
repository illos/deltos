-- ROAD-0005 P4 — denial-of-wallet durable usage counters. A per-account, per-UTC-day tally of calls to
-- the COST-bearing endpoints (Workers AI transcribe, server-side unfurl egress, R2 blob writes, MCP tool
-- calls). The Tier-2 HARD cost cap: the native rate-limit binding (Tier-1, env.API_RATE_LIMITER) is
-- per-colo + eventually-consistent ("intentionally not an accurate accounting system" — CF docs), so it
-- bounds request RATE cheaply but cannot bound cumulative SPEND. This durable global counter does.
--
-- Keyed (accountId, metric, dayBucket) so each account/metric/day is one row; the day rolls the budget.
-- Low write volume (only the paid paths touch it, and those are not the hot sync path), so D1 cost here
-- does not regress the load-feel north-star. Old rows are reaped by the scheduled prune (index.ts
-- `scheduled()` → pruneUsage), so the table never grows unbounded.
CREATE TABLE usageCounter (
  accountId TEXT NOT NULL,    -- the account the spend is attributed to (server-derived; BOLA-safe)
  metric    TEXT NOT NULL,    -- 'transcribe' | 'unfurl' | 'blobWrite' | 'mcp' (UsageMetric in abusePolicy.ts)
  dayBucket TEXT NOT NULL,    -- 'YYYY-MM-DD' in UTC; the daily window the cap applies over
  count     INTEGER NOT NULL DEFAULT 0,  -- calls so far in this account/metric/day
  updatedAt TEXT NOT NULL,    -- ISO-8601 of the last bump (observability only)
  PRIMARY KEY (accountId, metric, dayBucket)
);
