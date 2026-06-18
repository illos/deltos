/**
 * Visibility-gated pull cadence tests (jsdom env — document + window events available).
 *
 * Covered:
 *   ST-1  poll starts (setInterval called) with the correct delay when document is visible
 *   ST-2  poll does NOT start (setInterval skipped) when document starts hidden
 *   ST-3  immediate syncNow fires on visibilitychange→visible (core P0 fix)
 *   ST-4  poll suspends (clearInterval called) on visibilitychange→hidden
 *   ST-5  cleanup teardown clears the interval
 *
 * Timer safety: ST-1/2/4/5 spy on setInterval/clearInterval — no Dexie operations fire,
 * so vi.useFakeTimers is not needed and not used. ST-3 uses real timers with fake-indexeddb
 * to let the async syncNow chain settle. No liveQuery is active in any test.
 * See dexie-faketimers-deadlock memory for the constraint.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { NotebookId } from '@deltos/shared';
import { useAuthStore } from '../src/auth/store.js';
import { startSyncTriggers, SYNC_PULL_CADENCE } from '../src/lib/syncEngine.js';

const NB = '55551111-5555-4555-8555-555511111111' as NotebookId;

function setVisibilityState(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all([db.notes.clear(), db.syncQueue.clear()]);
  useAuthStore.setState({
    accountId: 'st-acct-id',
    bearerToken: 'st-bearer-tok',
    sessionState: 'active',
    isAuthed: true,
  });
  setVisibilityState('visible');
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  setVisibilityState('visible');
});

describe('ST-1 — poll starts with correct cadence when document is visible', () => {
  it('calls setInterval with SYNC_PULL_CADENCE.visibleIntervalMs on init', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const stop = startSyncTriggers(NB, 'http://localhost');

    const delays = spy.mock.calls.map((args) => args[1]);
    expect(delays).toContain(SYNC_PULL_CADENCE.visibleIntervalMs);

    stop();
  });
});

describe('ST-2 — no poll when document starts hidden', () => {
  it('does NOT call setInterval when document.visibilityState is hidden', () => {
    setVisibilityState('hidden');
    const spy = vi.spyOn(globalThis, 'setInterval');
    const stop = startSyncTriggers(NB, 'http://localhost');

    expect(spy).not.toHaveBeenCalled();

    stop();
  });
});

describe('ST-3 — immediate pull on visibilitychange→visible (core P0 fix)', () => {
  it('fires a pull fetch when document transitions from hidden to visible', async () => {
    setVisibilityState('hidden');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), { status: 200 }),
    );
    global.fetch = fetchMock;

    const stop = startSyncTriggers(NB, 'http://localhost');
    expect(fetchMock).not.toHaveBeenCalled(); // no poll while hidden

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    // Let the async syncNow chain settle (pull → fetch → mergeServerNotes)
    await new Promise((r) => setTimeout(r, 100));

    expect(fetchMock).toHaveBeenCalled();
    stop();
  });
});

describe('ST-4 — poll suspends on visibilitychange→hidden', () => {
  it('calls clearInterval when document transitions to hidden', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const stop = startSyncTriggers(NB, 'http://localhost'); // poll starts

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(clearSpy).toHaveBeenCalled();
    stop();
  });
});

describe('ST-5 — cleanup stops the poll', () => {
  it('the returned teardown function clears the active interval', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const stop = startSyncTriggers(NB, 'http://localhost');

    stop();

    expect(clearSpy).toHaveBeenCalled();
  });
});
