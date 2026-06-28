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
import { loadBlobBytes, loadThumbUrl, loadViewUrl } from './blobClient.js';

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

    // the hit touched lastAccess (LRU recency).
    const row = await db.blobCache.get(['acctA', 'coldHash']);
    expect(row!.lastAccess).toBeGreaterThan(1);
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

  it('LRU evicts the oldest-by-lastAccess rows once the total size exceeds the budget', async () => {
    const BUDGET = 200 * 1024 * 1024;
    const big = Math.floor(BUDGET / 2); // 100MB each → two fit (200MB), a third overflows
    await db.blobCache.bulkPut([
      { accountId: 'acctA', resourceKey: 'old', bytes: bytesOf(1), size: big, lastAccess: 1 },
      { accountId: 'acctA', resourceKey: 'mid', bytes: bytesOf(1), size: big, lastAccess: 2 },
    ]);

    // A new ~100MB network write pushes the total to ~300MB → over budget → evict the oldest ('old').
    fetchMock.mockResolvedValueOnce(okResponse(bytesOf(big, 3)));
    await loadBlobBytes('newHash');

    for (let i = 0; i < 100; i++) {
      if (!(await db.blobCache.get(['acctA', 'old']))) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await db.blobCache.get(['acctA', 'old'])).toBeUndefined(); // oldest evicted
    expect(await db.blobCache.get(['acctA', 'mid'])).toBeDefined();
    expect(await db.blobCache.get(['acctA', 'newHash'])).toBeDefined();
  });

  it('wipeLocalState clears the blob cache (the account-switch + logout seam)', async () => {
    await db.blobCache.put({
      accountId: 'acctA', resourceKey: 'h', bytes: bytesOf(4), size: 4, lastAccess: 1,
    });
    expect(await db.blobCache.count()).toBe(1);

    // ensureAccountScope to a DIFFERENT account routes through wipeLocalState (same seam logout uses).
    await ensureAccountScope('someoneElse');
    expect(await db.blobCache.count()).toBe(0);
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
