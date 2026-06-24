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
import { startSyncTriggers, SYNC_PULL_CADENCE, SYNC_IDLE_TIMEOUT_MS } from '../src/lib/syncEngine.js';

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

// #91 — idle gate. shouldBeActive = (!hidden) AND (!idle); pause on idle only, never on mere unfocus.
describe('ST-6 — visible-but-unfocused does NOT pause (blur is not a pause trigger)', () => {
  it('a window blur leaves the poll running', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const stop = startSyncTriggers(NB, 'http://localhost');
    window.dispatchEvent(new Event('blur'));
    expect(clearSpy).not.toHaveBeenCalled(); // side-by-side windows keep live-syncing
    stop();
  });
});

describe('ST-7 — idle timeout pauses the poll', () => {
  it('once the idle timeout elapses with no interaction, the poll stops', () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      global.fetch = vi.fn(async (url) => String(url).includes('/push') ? new Response(JSON.stringify({ results: [] }), { status: 200 }) : new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), { status: 200 })) as typeof fetch;
      const stop = startSyncTriggers(NB, 'http://localhost');
      // The idle timer is the setTimeout armed at SYNC_IDLE_TIMEOUT_MS.
      const idleCb = setTimeoutSpy.mock.calls.find((c) => c[1] === SYNC_IDLE_TIMEOUT_MS)?.[0] as (() => void) | undefined;
      expect(idleCb).toBeDefined();
      vi.setSystemTime(Date.now() + SYNC_IDLE_TIMEOUT_MS + 1); // clock past idle (no timers fired)
      idleCb!(); // idle timer fires → reconcile → pause
      expect(clearSpy).toHaveBeenCalled();
      stop();
    } finally { vi.useRealTimers(); }
  });
});

describe('ST-8 — interaction after an idle pause resumes (catch-up poll)', () => {
  it('an activity event restarts the poll after idle', () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const intervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      global.fetch = vi.fn(async (url) => String(url).includes('/push') ? new Response(JSON.stringify({ results: [] }), { status: 200 }) : new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), { status: 200 })) as typeof fetch;
      const stop = startSyncTriggers(NB, 'http://localhost');
      const idleCb = setTimeoutSpy.mock.calls.find((c) => c[1] === SYNC_IDLE_TIMEOUT_MS)?.[0] as (() => void) | undefined;
      vi.setSystemTime(Date.now() + SYNC_IDLE_TIMEOUT_MS + 1);
      idleCb!(); // pause
      expect(clearSpy).toHaveBeenCalled();
      intervalSpy.mockClear();
      window.dispatchEvent(new Event('pointerdown')); // interaction → reset idle + resume
      expect(intervalSpy).toHaveBeenCalled(); // poll restarted (catch-up)
      stop();
    } finally { vi.useRealTimers(); }
  });
});

describe('ST-9 — activity while ALREADY active does not double-start the poll', () => {
  it('a throttled interaction in an active session does not re-startPoll (no double-syncNow churn)', () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const stop = startSyncTriggers(NB, 'http://localhost'); // active → one setInterval
    intervalSpy.mockClear();
    window.dispatchEvent(new Event('pointerdown')); // within the throttle window → no reconcile
    expect(intervalSpy).not.toHaveBeenCalled();
    stop();
  });
});
