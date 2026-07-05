/**
 * Content-addressed local blob cache (blob-cache feature). Locks the behavior the secSys review verifies:
 *   - a cache HIT (IndexedDB) returns WITHOUT a network call AND without a bearer — the cold-return 401-latch
 *     fix + instant reopen;
 *   - a MISS fetches + persists the bytes;
 *   - LRU evicts the oldest rows once the total size exceeds the budget;
 *   - ACCOUNT ISOLATION: account B can NEVER read account A's cached bytes for the SAME hash (different PK row);
 *   - `wipeLocalState` (account-switch + logout seam) clears the table;
 *   - `accountId===null` bypasses the cache entirely (no anonymous bucket).
 *
 * IDB writes run on REAL timers (dexie-faketimers-deadlock): Dexie's internal reactivity recurses under fake
 * timers, so this whole file uses real timers and never installs vi.useFakeTimers. The module is imported
 * ONCE (no vi.resetModules) so blobClient and this test share the one `useAuthStore` + `db` singleton; tests
 * use distinct hashes so the in-memory session cache never bleeds across cases.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useAuthStore } from '../../auth/store.js';
import { db } from '../../db/schema.js';
import { ensureAccountScope } from '../../db/accountScope.js';
import { loadBlobBytes, loadBlobUrl, loadThumbUrl, loadViewUrl, resetBlobMemory } from './blobClient.js';

const BLOB_API = '/api/plugin/blob';

function bytesOf(len: number, fill = 1): ArrayBuffer {
  const u = new Uint8Array(len);
  u.fill(fill);
  return u.buffer;
}

let fetchMock: ReturnType<typeof vi.fn>;

function setAccount(accountId: string | null): void {
  useAuthStore.setState({ accountId, bearerToken: accountId ? 'tok' : null });
}

function okResponse(bytes: ArrayBuffer): Response {
  return { ok: true, status: 200, arrayBuffer: async () => bytes } as unknown as Response;
}

// Wait for a fire-and-forget persist to land (the loaders persist AFTER returning the bytes).
async function waitForRow(accountId: string, resourceKey: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await db.blobCache.get([accountId, resourceKey])) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Wait for a fire-and-forget meta touch to land at/after a recency floor (touch runs AFTER the hit returns).
async function waitForMetaTouch(accountId: string, resourceKey: string, after: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const m = await db.blobCacheMeta.get([accountId, resourceKey]);
    if (m && m.lastAccess > after) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setAccount('acctA');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('content-addressed local blob cache', () => {
  it('MISS fetches from the network and persists the bytes to IndexedDB', async () => {
    const payload = bytesOf(8, 7);
    fetchMock.mockResolvedValueOnce(okResponse(payload));

    const out = await loadBlobBytes('missHash');
    expect(new Uint8Array(out)).toEqual(new Uint8Array(payload));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${BLOB_API}/missHash`, expect.anything());

    await waitForRow('acctA', 'missHash');
    const row = await db.blobCache.get(['acctA', 'missHash']);
    expect(row).toBeDefined();
    expect(new Uint8Array(row!.bytes)).toEqual(new Uint8Array(payload));
    expect(row!.size).toBe(8);
  });

  it('a session (memory) HIT returns the bytes with no second network call', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(bytesOf(8, 1)));
    await loadBlobBytes('memHash');
    await loadBlobBytes('memHash'); // second open
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an IndexedDB HIT needs no bearer (the cold-return fix): a pre-seeded row returns with no network', async () => {
    // Simulate a row persisted in a PRIOR session, fresh memory, account resident but bearer not yet minted.
    await db.blobCache.put({
      accountId: 'acctA', resourceKey: 'coldHash', bytes: bytesOf(8, 9), size: 8, lastAccess: 1,
    });
    useAuthStore.setState({ accountId: 'acctA', bearerToken: null }); // no bearer yet (pre-auth window)

    const out = await loadBlobBytes('coldHash');
    expect(new Uint8Array(out)).toEqual(new Uint8Array(bytesOf(8, 9)));
    expect(fetchMock).not.toHaveBeenCalled(); // served from IndexedDB → never raced the pre-auth 401

    // the hit touched LRU recency on the size-only sidecar (backfilling meta for this pre-seeded legacy row),
    // WITHOUT rewriting the bytes row.
    await waitForMetaTouch('acctA', 'coldHash', 1);
    const meta = await db.blobCacheMeta.get(['acctA', 'coldHash']);
    expect(meta!.lastAccess).toBeGreaterThan(1);
    expect(meta!.size).toBe(8); // size backfilled from the bytes row — no bytes deserialized for the budget
  });

  it('ACCOUNT ISOLATION: account B cannot read account A’s cached bytes for the SAME hash', async () => {
    // Account A has a cached row for 'shared'.
    await db.blobCache.put({
      accountId: 'acctA', resourceKey: 'shared', bytes: bytesOf(8, 0xaa), size: 8, lastAccess: 1,
    });

    // Account B opens the SAME hash → MUST miss A's row, hit the network, get B's own bytes.
    setAccount('acctB');
    const bBytes = bytesOf(8, 0xbb);
    fetchMock.mockResolvedValueOnce(okResponse(bBytes));

    const out = await loadBlobBytes('shared');
    expect(new Uint8Array(out)).toEqual(new Uint8Array(bBytes));
    expect(fetchMock).toHaveBeenCalledTimes(1); // B forced its own fetch — did NOT read A's row

    // Two distinct PK rows coexist, one per account — no cross-account read path exists.
    await waitForRow('acctB', 'shared');
    const aRow = await db.blobCache.get(['acctA', 'shared']);
    const bRow = await db.blobCache.get(['acctB', 'shared']);
    expect(new Uint8Array(aRow!.bytes)).toEqual(new Uint8Array(bytesOf(8, 0xaa)));
    expect(new Uint8Array(bRow!.bytes)).toEqual(new Uint8Array(bBytes));
  });

  it('accountId===null bypasses the cache entirely (no read, no write — no anonymous bucket)', async () => {
    setAccount(null);
    fetchMock.mockResolvedValueOnce(okResponse(bytesOf(4)));
    await loadBlobBytes('anonHash');
    expect(await db.blobCache.count()).toBe(0);
  });

  it('LRU evicts the oldest-by-lastAccess rows to under budget WITHOUT deserializing cached bytes', async () => {
    const BUDGET = 200 * 1024 * 1024;
    const big = Math.floor(BUDGET / 2); // 100MB each → two fit (200MB), a third overflows
    // The bytes rows hold TINY actual buffers while the meta records the REAL size, so a correct eviction MUST
    // read size from the sidecar (never the bytes). Seed both tables in lockstep (as persistBytes would).
    await db.blobCache.bulkPut([
      { accountId: 'acctA', resourceKey: 'old', bytes: bytesOf(1), size: big, lastAccess: 1 },
      { accountId: 'acctA', resourceKey: 'mid', bytes: bytesOf(1), size: big, lastAccess: 2 },
    ]);
    await db.blobCacheMeta.bulkPut([
      { accountId: 'acctA', resourceKey: 'old', size: big, lastAccess: 1 },
      { accountId: 'acctA', resourceKey: 'mid', size: big, lastAccess: 2 },
    ]);

    // Eviction must NEVER range-scan the bytes table (that's what materialized ~200MB on every write).
    const bytesOrderBy = vi.spyOn(db.blobCache, 'orderBy');

    // A new ~100MB network write pushes the total to ~300MB → over budget → evict the oldest ('old').
    fetchMock.mockResolvedValueOnce(okResponse(bytesOf(big, 3)));
    await loadBlobBytes('newHash');

    for (let i = 0; i < 100; i++) {
      if (!(await db.blobCache.get(['acctA', 'old']))) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    // Oldest evicted from BOTH tables; the rest survive in BOTH.
    expect(await db.blobCache.get(['acctA', 'old'])).toBeUndefined();
    expect(await db.blobCacheMeta.get(['acctA', 'old'])).toBeUndefined();
    expect(await db.blobCache.get(['acctA', 'mid'])).toBeDefined();
    expect(await db.blobCacheMeta.get(['acctA', 'mid'])).toBeDefined();
    expect(await db.blobCache.get(['acctA', 'newHash'])).toBeDefined();
    expect(await db.blobCacheMeta.get(['acctA', 'newHash'])).toBeDefined();
    // The budget math + victim selection ran entirely on the size-only sidecar — bytes were never scanned.
    expect(bytesOrderBy).not.toHaveBeenCalled();
  });

  it('wipeLocalState clears the blob cache (the account-switch + logout seam)', async () => {
    await db.blobCache.put({
      accountId: 'acctA', resourceKey: 'h', bytes: bytesOf(4), size: 4, lastAccess: 1,
    });
    expect(await db.blobCache.count()).toBe(1);

    // ensureAccountScope to a DIFFERENT account routes through wipeLocalState (same seam logout uses).
    await ensureAccountScope('someoneElse');
    expect(await db.blobCache.count()).toBe(0);
    expect(await db.blobCacheMeta.count()).toBe(0); // the size-only sidecar is dropped in lockstep
  });

  it('resetBlobMemory revokes live object URLs and clears the in-memory bytes/URL tiers', async () => {
    const revoke = vi.fn();
    let n = 0;
    vi.stubGlobal('URL', { createObjectURL: () => `blob:stub-${n++}`, revokeObjectURL: revoke });
    fetchMock.mockResolvedValue(okResponse(bytesOf(8)));

    await loadBlobUrl('memUrlHash', 'image/png'); // populates urlMem (object URL) + bytesMem
    await loadBlobUrl('memUrlHash', 'image/png'); // memory HIT — same URL, no second fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitForRow('acctA', 'memUrlHash'); // let the fire-and-forget persist land before we clear IDB below

    resetBlobMemory();
    expect(revoke).toHaveBeenCalledWith('blob:stub-0'); // the live object URL was revoked

    // Memory tiers cleared: with the durable IDB row also gone, the next load is a true MISS → re-fetch,
    // proving bytesMem was emptied (else it would have served from memory with no fetch).
    await db.blobCache.clear();
    await db.blobCacheMeta.clear();
    fetchMock.mockResolvedValue(okResponse(bytesOf(8)));
    await loadBlobUrl('memUrlHash', 'image/png');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('the wipe seam (onLocalWipe) releases blob memory: a switch revokes live URLs', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:wired', revokeObjectURL: revoke });
    fetchMock.mockResolvedValue(okResponse(bytesOf(8)));
    await loadBlobUrl('wiredHash', 'image/png'); // a live object URL now sits in urlMem

    // The account-switch wipe path must fire the registered resetBlobMemory (plugin → core seam).
    await ensureAccountScope('anotherAccount');
    expect(revoke).toHaveBeenCalledWith('blob:wired');
  });

  it('derivatives (thumb/view) cache under a resourceKey DISTINCT from the original hash', async () => {
    // node env has no URL.createObjectURL — stub it so loadDerivativeUrl can run.
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} });
    fetchMock.mockResolvedValue(okResponse(bytesOf(4)));

    await loadThumbUrl('imgHash');
    await loadViewUrl('imgHash');
    await waitForRow('acctA', 'imgHash:thumb');
    await waitForRow('acctA', 'imgHash:view');

    expect(await db.blobCache.get(['acctA', 'imgHash:thumb'])).toBeDefined();
    expect(await db.blobCache.get(['acctA', 'imgHash:view'])).toBeDefined();
    // the original hash itself was never written (derivatives are distinct content).
    expect(await db.blobCache.get(['acctA', 'imgHash'])).toBeUndefined();
  });
});

/**
 * On-auth-reject re-mint (blob path parity with syncFetch). A blob GET carries the short-TTL access token; an
 * expired token 403s. Before this, the blob path threw straight to the placeholder chip and only a later
 * bearer-identity change re-fired the load — the "images render as placeholders until I leave and come back"
 * bug. Now the fetch re-mints from the refresh cookie ONCE and retries, so a stale-token open self-heals.
 */
describe('blob load re-mints the bearer on a 401/403/503 and retries', () => {
  const realRemint = useAuthStore.getState().remintBearer;
  afterEach(() => {
    useAuthStore.setState({ remintBearer: realRemint }); // restore the real action on the shared singleton
  });

  it('a 403 (expired access token) re-mints ONCE and retries → bytes returned, no remount needed', async () => {
    const payload = bytesOf(8, 5);
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 403 } as unknown as Response) // stale token
      .mockResolvedValueOnce(okResponse(payload)); // retry with the fresh bearer
    const remint = vi.fn(async () => {
      useAuthStore.setState({ bearerToken: 'fresh' });
      return 'ok' as const;
    });
    useAuthStore.setState({ remintBearer: remint });

    const out = await loadBlobBytes('expiredHash');
    expect(new Uint8Array(out)).toEqual(new Uint8Array(payload));
    expect(remint).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); // first 403, then the retry
  });

  it('a 503 (absent bearer) also re-mints and retries', async () => {
    const payload = bytesOf(8, 6);
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response)
      .mockResolvedValueOnce(okResponse(payload));
    useAuthStore.setState({ remintBearer: vi.fn(async () => 'ok' as const) });

    const out = await loadBlobBytes('absentHash');
    expect(new Uint8Array(out)).toEqual(new Uint8Array(payload));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT latch a failure: a revoked re-mint throws, and a LATER read re-fetches clean (no cached failure)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 } as unknown as Response);
    useAuthStore.setState({ remintBearer: vi.fn(async () => 'revoked' as const) });
    await expect(loadBlobBytes('flapHash')).rejects.toThrow();

    // After a real re-login the very next read of the SAME hash must hit the network again — never a stuck chip.
    fetchMock.mockResolvedValueOnce(okResponse(bytesOf(8, 9)));
    useAuthStore.setState({ remintBearer: vi.fn(async () => 'ok' as const) });
    const out = await loadBlobBytes('flapHash');
    expect(new Uint8Array(out)).toEqual(new Uint8Array(bytesOf(8, 9)));
  });

  it('coalesces concurrent re-mints: two images racing a 403 share ONE /refresh', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 403 } as unknown as Response) // first image, stale
      .mockResolvedValueOnce({ ok: false, status: 403 } as unknown as Response) // second image, stale
      .mockResolvedValue(okResponse(bytesOf(8, 1))); // both retries
    let remints = 0;
    useAuthStore.setState({
      remintBearer: vi.fn(async () => {
        remints++;
        await new Promise((r) => setTimeout(r, 10)); // hold the in-flight window open so both loads join it
        useAuthStore.setState({ bearerToken: 'fresh' });
        return 'ok' as const;
      }),
    });

    await Promise.all([loadBlobBytes('coalX'), loadBlobBytes('coalY')]);
    expect(remints).toBe(1); // ONE shared re-mint, not one per image
  });
});
