/**
 * Custom-dictionary client store tests (§5.2). Covers the consumer API (listWords/addWord/removeWord/
 * observeWords + normalizeWord), the server-pull merge, and — the HARD requirement — ACCOUNT ISOLATION:
 * the account-switch wipe clears the dictionary tables so no word survives across accounts (#52 class).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { addWord, removeWord, listWords, observeWords, normalizeWord } from '../src/lib/dictionaryStore.js';

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all([db.dictionaryWords.clear(), db.dictionaryQueue.clear(), db.deviceState.clear()]);
  // addWord/removeWord arm the debounced sync push; stub fetch so a stray timer never hits the network.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('dictionaryStore — consumer API (§5.2)', () => {
  it('normalizeWord trims + lowercases so casing/whitespace collapse to one set element', () => {
    expect(normalizeWord('  Deltos ')).toBe('deltos');
    expect(normalizeWord('DELTOS')).toBe('deltos');
  });

  it('addWord makes the word live + enqueues a sync entry; listWords returns it', async () => {
    await addWord('Deltos');
    expect(await listWords()).toEqual(['deltos']); // normalized
    const { db } = await import('../src/db/schema.js');
    const queue = await db.dictionaryQueue.toArray();
    expect(queue).toHaveLength(1);
    expect(queue[0].payload).toEqual({ word: 'deltos' });
  });

  it('addWord is idempotent + dedup-safe (one row, one live word)', async () => {
    await addWord('deltos');
    await addWord('deltos');
    expect(await listWords()).toEqual(['deltos']);
  });

  it('removeWord tombstones the word (drops from listWords) + enqueues a delete entry', async () => {
    await addWord('deltos');
    await removeWord('deltos');
    expect(await listWords()).toEqual([]);
    const { db } = await import('../src/db/schema.js');
    const queue = await db.dictionaryQueue.toArray();
    const del = queue.find((e) => e.payload.delete === true);
    expect(del?.payload).toEqual({ word: 'deltos', delete: true });
  });

  it('blank words are ignored (no row, no queue entry)', async () => {
    await addWord('   ');
    expect(await listWords()).toEqual([]);
    const { db } = await import('../src/db/schema.js');
    expect(await db.dictionaryQueue.count()).toBe(0);
  });

  it('observeWords emits the live set reactively', async () => {
    const seen: string[][] = [];
    const unsub = observeWords((w) => seen.push(w));
    await addWord('alpha');
    await addWord('beta');
    await removeWord('alpha');
    // liveQuery is async; poll until the latest emission reflects the final state.
    await vi.waitFor(() => expect(seen[seen.length - 1]).toEqual(['beta']));
    unsub();
  });

  it('mergeDictionary applies server words: live appears, tombstone disappears', async () => {
    const { mergeDictionary } = await import('../src/lib/syncEngine.js');
    await mergeDictionary([
      { word: 'fromserver', createdAt: 'T', updatedAt: 'T', deletedAt: null, syncSeq: 5 },
      { word: 'removed', createdAt: 'T', updatedAt: 'T', deletedAt: 'T2', syncSeq: 6 },
    ]);
    expect(await listWords()).toEqual(['fromserver']); // tombstoned 'removed' filtered out
  });
});

describe('dictionaryStore — ACCOUNT ISOLATION (HARD requirement, #52 class)', () => {
  it('the account-switch wipe clears the dictionary tables — no word survives across accounts', async () => {
    const { db } = await import('../src/db/schema.js');
    const { ensureAccountScope } = await import('../src/db/accountScope.js');

    // Account A adds words + stamps the resident marker.
    await ensureAccountScope('account-A');
    await addWord('asecret');
    await addWord('aprivate');
    expect(await listWords()).toEqual(['aprivate', 'asecret']);

    // Switch to account B → wipe runs (marker differs).
    const wiped = await ensureAccountScope('account-B');
    expect(wiped).toBe(true);
    expect(await listWords()).toEqual([]); // A's words gone — never inherited by B
    expect(await db.dictionaryQueue.count()).toBe(0); // un-pushed entries dropped (W8 — never push under B's bearer)
  });
});
