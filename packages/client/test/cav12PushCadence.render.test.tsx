/**
 * CAV-1 and CAV-2 — push cadence + offline buffer (jsdom env).
 *
 * These run in jsdom (*.render.test.tsx naming → environmentMatchGlobs in vite.config.ts)
 * because startSyncTriggers wires window events (online/offline/visibilitychange/pagehide)
 * and vi.useFakeTimers() in jsdom leaks into fake-indexeddb's IDB operations when mixed with
 * Dexie-heavy tests in the same file. Separating here keeps the node-env Dexie tests clean.
 *
 * Spec:    docs/specs/v1-shell-and-conflict-versions.md §Part 2
 * Matrix:  docs/specs/v1-shell-conflict-acceptance-matrix.md
 *
 * CAV-1: push cadence — debounced observer (SYNC_PUSH_CADENCE 2s idle-settle, 5s max-wait cap)
 *   startSyncTriggers is OPT-IN (not auto on module load) so the controlled syncEngine.test.ts
 *   trip-wire tests (CAV-12) never see spurious pushes from the observer.
 * CAV-2: offline buffer → flush on reconnect via the 'online' event listener wired by startSyncTriggers.
 *
 * Fake-timer note (CAV-1): liveQuery emits async — after a queue write, await
 * vi.advanceTimersByTimeAsync(0) to let the observer schedule before advancing timers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Note, NoteId, NotebookId } from '@deltos/shared';
import { useAuthStore } from '../src/auth/store.js';

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  useAuthStore.setState({ accountId: null, bearerToken: null, sessionState: 'booting' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NB = 'nb-cav12-00000000-0000-4000-8000-000000000001' as NotebookId;
const NOW = '2026-06-16T10:00:00.000Z';
const NOTE_ID = 'note-cav12-0000-0000-4000-8000-000000000001' as NoteId;

function makeNote(id: string, version = 0, title = 'Test note'): Note {
  return {
    id: id as NoteId,
    notebookId: NB,
    title,
    properties: {},
    body: [],
    version,
    createdAt: NOW,
    updatedAt: NOW,
    syncStatus: 'local-only',
  };
}

function setSession() {
  useAuthStore.setState({ accountId: 'cav12-acct-01', bearerToken: 'cav12-tok', sessionState: 'active' });
}

function mockFetchAccepted() {
  global.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/sync/push')) {
      return new Response(
        JSON.stringify({ results: [{ id: NOTE_ID, outcome: 'accepted', version: 1, syncSeq: 1 }] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), { status: 200 });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// CAV-1 — push cadence: debounced push respects 2s idle-settle + 5s max-wait cap
// ---------------------------------------------------------------------------

describe('CAV-1 — push cadence: debounced server push (2s idle-settle, 5s max-wait cap)', () => {
  let stopTriggers: (() => void) | undefined;

  afterEach(() => {
    stopTriggers?.();
    stopTriggers = undefined;
  });

  it('an edit does not push immediately — respects the idle-settle window', async () => {
    setSession();
    const { db } = await import('../src/db/schema.js');
    const { startSyncTriggers, notifyQueueWrite } = await import('../src/lib/syncEngine.js');

    // IDB write with real timers — keeps Dexie's reactivity setTimeout(0)s out of the fake pool.
    const note = makeNote(NOTE_ID, 0, 'Typing...');
    await db.notes.put(note);
    await db.syncQueue.add({
      id: crypto.randomUUID(),
      recordId: NOTE_ID,
      payload: note,
      baseVersion: 0,
      createdAt: NOW,
    });

    vi.useFakeTimers(); // switch AFTER writes; fake pool starts clean
    stopTriggers = startSyncTriggers(NB, 'cav12-tok');
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    notifyQueueWrite(NB, 'cav12-tok'); // arm the 2s idle-settle debounce timer

    // 1.5s elapsed — still inside the 2s settle window; no push yet.
    vi.advanceTimersByTime(1500); // synchronous: only pending timer is debounce at 2000ms
    const pushCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/sync/push'));
    expect(pushCalls).toHaveLength(0);
  });

  it('an edit DOES push after the 2s idle-settle window elapses', async () => {
    setSession();
    const { db } = await import('../src/db/schema.js');
    const { startSyncTriggers, notifyQueueWrite } = await import('../src/lib/syncEngine.js');

    // IDB write with real timers.
    const note = makeNote(NOTE_ID, 0, 'Settled edit');
    await db.notes.put(note);
    await db.syncQueue.add({
      id: crypto.randomUUID(),
      recordId: NOTE_ID,
      payload: note,
      baseVersion: 0,
      createdAt: NOW,
    });

    vi.useFakeTimers(); // switch AFTER writes
    mockFetchAccepted();
    const fetchSpy = vi.spyOn(global, 'fetch');
    stopTriggers = startSyncTriggers(NB, 'cav12-tok');
    notifyQueueWrite(NB, 'cav12-tok'); // arm the 2s idle-settle debounce timer

    // Async advance: fires the 2000ms debounce and flushes syncNow's sequential IDB-read chain.
    await vi.advanceTimersByTimeAsync(2100);

    const pushed = fetchSpy.mock.calls.some(([url]) => String(url).includes('/sync/push'));
    expect(pushed).toBe(true);
  });

  it('continuous typing flushes at most once per 5s max-wait cap (never per-keystroke)', async () => {
    setSession();
    const { db } = await import('../src/db/schema.js');
    const { startSyncTriggers, notifyQueueWrite } = await import('../src/lib/syncEngine.js');

    // Pre-populate 9 edits with real timers so no Dexie reactivity timers enter the fake pool.
    for (let i = 0; i < 9; i++) {
      const note = makeNote(NOTE_ID, i, `Keystroke ${i}`);
      await db.notes.put(note);
      await db.syncQueue.add({
        id: crypto.randomUUID(),
        recordId: NOTE_ID,
        payload: note,
        baseVersion: i,
        createdAt: NOW,
      });
    }

    vi.useFakeTimers(); // switch AFTER writes; fake pool starts clean
    mockFetchAccepted();
    const fetchSpy = vi.spyOn(global, 'fetch');
    stopTriggers = startSyncTriggers(NB, 'cav12-tok');

    // Simulate 9 keystrokes at 500ms intervals — total 4500ms, below the 5000ms max-wait cap.
    for (let i = 0; i < 9; i++) {
      notifyQueueWrite(NB, 'cav12-tok'); // (re)arm idle timer; max-wait armed once on first call
      vi.advanceTimersByTime(500); // synchronous: no user timer fires (idle resets, max-wait at 5000ms)
    }

    // At 4500ms: idle was last reset, max-wait (5000ms) hasn't fired. 0 pushes is ≤1.
    const pushCount = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('/sync/push'),
    ).length;
    expect(pushCount).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// CAV-2 — offline buffer → flush on reconnect
// ---------------------------------------------------------------------------

describe('CAV-2 — offline buffer: edits queued offline are flushed when back online', () => {
  it('edits made while offline accumulate in syncQueue and push once the online event fires', async () => {
    setSession();

    // Simulate offline: fetch always rejects.
    global.fetch = vi.fn(() => Promise.reject(new TypeError('Network error'))) as typeof fetch;

    const { db } = await import('../src/db/schema.js');
    const { startSyncTriggers } = await import('../src/lib/syncEngine.js');
    const stop = startSyncTriggers(NB, 'cav12-tok');

    const note = makeNote(NOTE_ID, 0, 'Offline edit');
    await db.notes.put(note);
    await db.syncQueue.add({
      id: crypto.randomUUID(),
      recordId: NOTE_ID,
      payload: note,
      baseVersion: 0,
      createdAt: NOW,
    });

    // Still queued — not flushed while offline.
    expect(await db.syncQueue.where('recordId').equals(NOTE_ID).count()).toBe(1);

    // Come back online: wire a successful push and fire the browser 'online' event.
    mockFetchAccepted();
    window.dispatchEvent(new Event('online'));
    await new Promise((r) => setTimeout(r, 200));

    stop();

    // Queue should be drained after reconnect.
    expect(await db.syncQueue.where('recordId').equals(NOTE_ID).count()).toBe(0);
  });
});
