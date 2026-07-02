/**
 * ROAD-0005 P4 — abuse & cost-control FOUNDATION (Tier-2 durable quota + Tier-3 prune + Tier-1 rate wrapper).
 *
 * Covers the spine the route wiring builds on:
 * - chargeUsage: allows under cap, denies AT cap WITHOUT charging, counts per (account, metric, day),
 *   isolates accounts/metrics/days, and the day-roll resets the budget.
 * - pruneUsage / pruneAuditLog: reap strictly-older rows, keep on/after the cutoff.
 * - dayBucket: UTC 'YYYY-MM-DD'.
 * - principalRateAllow: fail-OPEN when the binding is unbound or throws; honors the binding's verdict.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { DbAdapter } from '../src/db/schema.js';
import { createAuthStore, type AuthStore } from '../src/db/authStore.js';
import { dayBucket } from '../src/abusePolicy.js';
import { principalRateAllow } from '../src/rateLimit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const migrations = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0013_agent-token-label.sql',
  '0014_grant-family-link.sql',
  '0015_audit-log.sql',
  '0016_usage-counter.sql',
  '0017_oauth-provider.sql', '0018_fts5-note-search.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function sqliteAdapter(db: Database.Database): DbAdapter {
  return {
    async batch(stmts) {
      const results: { rowsWritten: number }[] = [];
      const txn = db.transaction(() => {
        for (const s of stmts) {
          const info = db.prepare(s.sql).run(...(s.params as Array<string | number | null>));
          results.push({ rowsWritten: info.changes });
        }
      });
      txn();
      return results;
    },
    async first<T>(sql: string, params: unknown[]) {
      return (db.prepare(sql).get(...(params as Array<string | number | null>)) as T) ?? null;
    },
    async all<T>(sql: string, params: unknown[]) {
      return db.prepare(sql).all(...(params as Array<string | number | null>)) as T[];
    },
  };
}

let store: AuthStore;
let raw: Database.Database;

beforeEach(() => {
  raw = new Database(':memory:');
  for (const m of migrations) raw.exec(m);
  store = createAuthStore(sqliteAdapter(raw));
});

const ISO = '2026-06-30T12:00:00.000Z';

describe('chargeUsage (Tier-2 denial-of-wallet)', () => {
  it('allows while under cap and increments the count', async () => {
    const a = await store.chargeUsage('acct-1', 'transcribe', '2026-06-30', 3, ISO);
    expect(a).toEqual({ allowed: true, count: 1 });
    const b = await store.chargeUsage('acct-1', 'transcribe', '2026-06-30', 3, ISO);
    expect(b).toEqual({ allowed: true, count: 2 });
    const c = await store.chargeUsage('acct-1', 'transcribe', '2026-06-30', 3, ISO);
    expect(c).toEqual({ allowed: true, count: 3 });
  });

  it('denies AT the cap without charging further', async () => {
    for (let i = 0; i < 3; i++) await store.chargeUsage('acct-1', 'transcribe', '2026-06-30', 3, ISO);
    const over = await store.chargeUsage('acct-1', 'transcribe', '2026-06-30', 3, ISO);
    expect(over.allowed).toBe(false);
    expect(over.count).toBe(3); // unchanged — the denied call did not bump the counter
    const row = raw
      .prepare('SELECT count FROM usageCounter WHERE accountId=? AND metric=? AND dayBucket=?')
      .get('acct-1', 'transcribe', '2026-06-30') as { count: number };
    expect(row.count).toBe(3);
  });

  it('is a HARD ceiling — repeated calls past the cap never push the counter above cap', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      results.push((await store.chargeUsage('acct-1', 'mcp', '2026-06-30', 2, ISO)).allowed);
    }
    expect(results).toEqual([true, true, false, false, false, false]); // exactly `cap` (=2) charges succeed
    const row = raw
      .prepare('SELECT count FROM usageCounter WHERE accountId=? AND metric=? AND dayBucket=?')
      .get('acct-1', 'mcp', '2026-06-30') as { count: number };
    expect(row.count).toBe(2); // guarded UPSERT made the over-cap calls true no-ops — count never exceeds cap
  });

  it('isolates by account, metric, and day', async () => {
    await store.chargeUsage('acct-1', 'transcribe', '2026-06-30', 1, ISO); // acct-1 transcribe maxed
    // a different account is unaffected
    expect((await store.chargeUsage('acct-2', 'transcribe', '2026-06-30', 1, ISO)).allowed).toBe(true);
    // a different metric on the same account is unaffected
    expect((await store.chargeUsage('acct-1', 'unfurl', '2026-06-30', 1, ISO)).allowed).toBe(true);
    // the next day rolls the budget
    expect((await store.chargeUsage('acct-1', 'transcribe', '2026-07-01', 1, ISO)).allowed).toBe(true);
  });
});

describe('retention prune (Tier-3)', () => {
  it('pruneUsage reaps strictly-older day buckets, keeps the cutoff day', async () => {
    await store.chargeUsage('acct-1', 'transcribe', '2026-06-20', 5, ISO);
    await store.chargeUsage('acct-1', 'transcribe', '2026-06-25', 5, ISO);
    await store.pruneUsage('2026-06-25'); // strictly before → removes the 20th, keeps the 25th
    const rows = raw.prepare('SELECT dayBucket FROM usageCounter ORDER BY dayBucket').all() as {
      dayBucket: string;
    }[];
    expect(rows.map((r) => r.dayBucket)).toEqual(['2026-06-25']);
  });

  it('pruneAuditLog reaps rows older than the cutoff ts', async () => {
    const base = {
      surface: 'auth',
      action: 'login',
      result: 'allow' as const,
      principalKind: 'owner',
      credentialRef: null,
      resourceKind: null,
      resourceId: null,
      ip: null,
      country: null,
      userAgent: null,
      detail: null,
    };
    await store.insertAuditLog({ ...base, accountId: 'acct-1', ts: '2026-01-01T00:00:00.000Z' });
    await store.insertAuditLog({ ...base, accountId: 'acct-1', ts: '2026-06-30T00:00:00.000Z' });
    await store.pruneAuditLog('2026-06-01T00:00:00.000Z');
    const rows = await store.listAuditLogForAccount('acct-1', 10);
    expect(rows.map((r) => r.ts)).toEqual(['2026-06-30T00:00:00.000Z']);
  });
});

describe('dayBucket', () => {
  it('is the UTC YYYY-MM-DD of the instant', () => {
    expect(dayBucket(Date.parse('2026-06-30T23:59:59.999Z'))).toBe('2026-06-30');
    expect(dayBucket(Date.parse('2026-07-01T00:00:00.000Z'))).toBe('2026-07-01');
  });
});

describe('principalRateAllow (Tier-1 fail-open wrapper)', () => {
  it('allows when the binding is unbound (tests / unconfigured)', async () => {
    expect(await principalRateAllow(undefined, 'acct-1')).toBe(true);
  });

  it('allows when the binding throws (transient error never blocks legit traffic)', async () => {
    const limiter = { limit: async () => { throw new Error('limiter down'); } };
    expect(await principalRateAllow(limiter, 'acct-1')).toBe(true);
  });

  it('honors the binding verdict otherwise', async () => {
    expect(await principalRateAllow({ limit: async () => ({ success: true }) }, 'k')).toBe(true);
    expect(await principalRateAllow({ limit: async () => ({ success: false }) }, 'k')).toBe(false);
  });
});
