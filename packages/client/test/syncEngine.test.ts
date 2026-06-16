/**
 * Client-side sync engine tests — RED before implementation, GREEN after.
 *
 * Covers the four acceptance criteria that live in the client:
 *   - single-flight-no-double-apply
 *   - edit-while-syncing
 *   - pending-edit-pull-guard
 *   - delete-vs-edit-resurrection
 *
 * Uses fake-indexeddb so Dexie runs in Node without a real browser.
 * Mock fetch intercepts push/pull requests and returns controlled server responses.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import type { Note, NotebookId } from '@deltos/shared';
import type { SyncNote } from '@deltos/shared';

// Reset state between tests. The Dexie instance is a module singleton shared across every test
// in this file (fake-indexeddb only auto-resets between test FILES, not between tests), so without
// this clear, a queue entry left behind by one test bleeds into the next — masking real races
// (e.g. a leftover entry can consume a held push slot so an in-flight-edit test never exercises
// the path it claims to). Clear the tables before each test for genuine isolation.
beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all([db.notes.clear(), db.syncQueue.clear(), db.notebooks.clear()]);
});

// We import the engine AFTER setting up fake-indexeddb so Dexie picks up the shim.
// Dynamic import also lets us re-import with a fresh module state for single-flight tests.

const NB = 'nb-test-00000000-0000-4000-8000-000000000001' as NotebookId;
const NOW = '2026-06-15T12:00:00.000Z';

function makeNote(id: string, version = 0, title = 'Test note'): Note {
  return {
    id: id as Note['id'],
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

function makeSyncNote(note: Note, deletedAt: string | null = null, syncSeq = 1): SyncNote {
  return { ...note, syncStatus: 'synced', deletedAt, syncSeq };
}

// ---------------------------------------------------------------------------
// Test 1: single-flight — syncNow() in-progress blocks a second concurrent call
// ---------------------------------------------------------------------------

describe('single-flight guard (PIN-SYNC-1 client gate)', () => {
  it('a second syncNow() while one is in flight does not start a second concurrent push', async () => {
    // We verify the single-flight guarantee by checking that fetch is called at most once
    // per in-flight cycle, not multiple times for simultaneous triggers.

    let fetchCallCount = 0;
    let resolvePush!: (v: unknown) => void;
    const pushLatch = new Promise((r) => (resolvePush = r));

    const seedNoteId = 'note-sf-00000000-0000-4000-8000-000000000001';

    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/sync/push')) {
        fetchCallCount++;
        await pushLatch; // hold open so we can fire a second syncNow() mid-flight
        // Return accepted for the seeded entry so the queue drains — otherwise the deferred
        // _syncPending cycle would push again, giving fetchCallCount = 2 not 1.
        return new Response(
          JSON.stringify({ results: [{ id: seedNoteId, outcome: 'accepted', version: 1, syncSeq: 1 }] }),
          { status: 200 },
        );
      }
      // pull — return empty
      return new Response(
        JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }),
        { status: 200 },
      );
    }) as typeof fetch;

    // Stub localStorage for cursor
    const storage: Record<string, string> = {};
    global.localStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = v; },
      removeItem: (k: string) => { delete storage[k]; },
    } as unknown as Storage;

    const { syncNow } = await import('../src/lib/syncEngine.js');

    // Seed a queue entry so pushQueued() actually fires a fetch (otherwise it returns early)
    const { db } = await import('../src/db/schema.js');
    const seedNote = makeNote(seedNoteId, 0, 'Single flight seed');
    await db.notes.put(seedNote);
    await db.syncQueue.add({ id: crypto.randomUUID(), recordId: seedNote.id, payload: seedNote, baseVersion: 0, createdAt: NOW });

    // Fire three rapid triggers — only the first must result in a push fetch call
    syncNow(NB, '');
    syncNow(NB, '');
    syncNow(NB, '');

    // Let the first cycle finish
    resolvePush(undefined);
    await new Promise((r) => setTimeout(r, 50));

    // Only one push request must have been issued despite three concurrent triggers
    expect(fetchCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 1b: sync requests carry the in-memory grant token (Stream-D auth header, F7)
// ---------------------------------------------------------------------------

describe('Authorization header (Stream-D, F7 in-memory token)', () => {
  it('attaches Authorization: Bearer <token> to push AND pull, read from the in-memory auth store', async () => {
    const { useAuthStore } = await import('../src/auth/store.js');
    useAuthStore.setState({ bearerToken: 'grant-tok-abc' });

    const seedId = 'note-auth-00000000-0000-4000-8000-000000000001';
    const seen: { push?: string; pull?: string } = {};

    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
      if (u.includes('/sync/push')) {
        seen.push = auth;
        return new Response(
          JSON.stringify({ results: [{ id: seedId, outcome: 'accepted', version: 1, syncSeq: 1 }] }),
          { status: 200 },
        );
      }
      seen.pull = auth;
      return new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), { status: 200 });
    }) as typeof fetch;

    const storage: Record<string, string> = {};
    global.localStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = v; },
      removeItem: (k: string) => { delete storage[k]; },
    } as unknown as Storage;

    const { syncNow } = await import('../src/lib/syncEngine.js');
    const { db } = await import('../src/db/schema.js');
    const seedNote = makeNote(seedId, 0, 'auth header seed');
    await db.notes.put(seedNote);
    await db.syncQueue.add({ id: crypto.randomUUID(), recordId: seedId, payload: seedNote, baseVersion: 0, createdAt: NOW });

    syncNow(NB, '');
    await new Promise((r) => setTimeout(r, 50));

    expect(seen.push).toBe('Bearer grant-tok-abc');
    expect(seen.pull).toBe('Bearer grant-tok-abc');

    // F7 + test isolation: clear the in-memory token so it can't leak into other tests.
    useAuthStore.setState({ bearerToken: null });
  });
});

// ---------------------------------------------------------------------------
// Test 2: pending-edit pull guard — pull must not stomp a note with a local edit
// ---------------------------------------------------------------------------

describe('pending-edit pull guard (PIN-SYNC-1 landmine)', () => {
  it('incoming pull update is skipped when the note has a pending local edit in syncQueue', async () => {
    // Set up the DB with a local edit in the queue for note X
    const { db } = await import('../src/db/schema.js');
    const { mergePull } = await import('../src/lib/syncEngine.js');

    const noteId = 'note-pull-guard-00000000-0000-4000-8000-000000000001';
    const localNote = makeNote(noteId, 2, 'My local edit');
    localNote.syncStatus = 'pending';

    // Put the note in the local store
    await db.notes.put(localNote);

    // Put a syncQueue entry for this note (simulating an in-flight or pending edit)
    await db.syncQueue.add({
      id: crypto.randomUUID(),
      recordId: noteId,
      payload: localNote,
      baseVersion: 1,
      createdAt: NOW,
    });

    // Server sends an update for the same note (e.g. from another device)
    const serverVersion = makeNote(noteId, 3, 'Server version — must not overwrite local');
    const pullNotes: SyncNote[] = [makeSyncNote(serverVersion)];

    await mergePull(pullNotes, NB);

    // Local note must NOT be overwritten — still at version 2 with the local title
    const afterMerge = await db.notes.get(noteId as Note['id']);
    expect(afterMerge).not.toBeNull();
    expect(afterMerge!.title).toBe('My local edit');
    expect(afterMerge!.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 3: delete-vs-edit resurrection (PIN-SYNC-3)
// ---------------------------------------------------------------------------

describe('delete-vs-edit resurrection (PIN-SYNC-3)', () => {
  it('conflict with a tombstone creates a fork with the resurrection label and removes the original', async () => {
    const { db } = await import('../src/db/schema.js');

    // We test handleConflict (an internal function) by importing it — if it's not exported,
    // we test via the push flow with a controlled server response.
    //
    // The spec requirement: when serverNote is null (tombstone), a fork is created with title
    // prefixed "(deleted on another device — your edits kept)".

    const noteId = 'note-resurrection-00000000-0000-4000-8000-000000000001';
    const localEdit = makeNote(noteId, 1, 'My offline edit');
    await db.notes.put(localEdit);

    // Simulate what happens after the push path receives a conflict with serverNote = null
    // by calling handleConflict directly via the push path mock.
    // We mock fetch to return a conflict with serverNote: null for this note.

    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/sync/push')) {
        return new Response(
          JSON.stringify({
            results: [{ id: noteId, outcome: 'conflict', serverNote: null }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }),
        { status: 200 },
      );
    }) as typeof fetch;

    const storage: Record<string, string> = {};
    global.localStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = v; },
      removeItem: (k: string) => { delete storage[k]; },
    } as unknown as Storage;

    // Put the note in the queue
    await db.syncQueue.add({
      id: crypto.randomUUID(),
      recordId: noteId,
      payload: localEdit,
      baseVersion: 0,
      createdAt: NOW,
    });

    const { syncNow } = await import('../src/lib/syncEngine.js');
    syncNow(NB, '');
    await new Promise((r) => setTimeout(r, 100)); // let async chain complete

    // Original note must be deleted (server tombstoned it)
    const original = await db.notes.get(noteId as Note['id']);
    expect(original).toBeUndefined();

    // A fork must exist with the resurrection label in its title
    const all = await db.notes.toArray();
    const fork = all.find((n) => n.title.startsWith('(deleted on another device'));
    expect(fork).toBeDefined();
    expect(fork!.title).toContain('My offline edit');
    // Fork gets a new ID — not the original noteId
    expect(fork!.id).not.toBe(noteId);
  });
});

// ---------------------------------------------------------------------------
// Test 3c: pending edit survives a server conflict as fork content (secSys data-loss audit)
//
// The TOCTOU silent-loss chain secSys flagged: a pull stomps a pending-edit note, then the next
// push conflict-forks the STOMPED state (not the edit) and blanket-drains the edit's queue entry =>
// edit lost. The fix computes the pending guard INSIDE mergeServerNotes' notes+queue transaction so
// a pending note is never stomped; this locks the observable property — a pending edit hit by a
// (non-tombstone) server conflict is preserved as the conflict-copy fork, never silently dropped.
// ---------------------------------------------------------------------------

describe('pending edit preserved on conflict (secSys TOCTOU audit)', () => {
  it('a pending local edit survives a non-tombstone server conflict as the fork content', async () => {
    const { db } = await import('../src/db/schema.js');

    const noteId = 'note-toctou-000000000-0000-4000-8000-000000000001';
    const localEdit = makeNote(noteId, 1, 'My unsent edit');
    await db.notes.put(localEdit);
    await db.syncQueue.add({
      id: crypto.randomUUID(),
      recordId: noteId,
      payload: localEdit,
      baseVersion: 0,
      createdAt: NOW,
    });

    const serverNote = makeNote(noteId, 5, 'Server state from another device');

    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/sync/push')) {
        return new Response(
          JSON.stringify({ results: [{ id: noteId, outcome: 'conflict', serverNote }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), { status: 200 });
    }) as typeof fetch;

    const storage: Record<string, string> = {};
    global.localStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = v; },
      removeItem: (k: string) => { delete storage[k]; },
    } as unknown as Storage;

    const { syncNow } = await import('../src/lib/syncEngine.js');
    syncNow(NB, '');
    await new Promise((r) => setTimeout(r, 100));

    const all = await db.notes.toArray();
    // The original id adopts server state...
    const original = all.find((n) => n.id === noteId);
    expect(original?.title).toBe('Server state from another device');
    // ...and the unsent edit survives as a conflict-copy fork — NOT silently lost.
    const fork = all.find((n) => n.title.startsWith('(conflict copy)'));
    expect(fork).toBeDefined();
    expect(fork!.title).toContain('My unsent edit');
    expect(fork!.id).not.toBe(noteId);
    // The edit's queue entry was blanket-drained (its content now lives in the fork).
    expect(await db.syncQueue.where('recordId').equals(noteId).count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3b: stale superseded queue entries are drained on accept (not re-pushed)
// ---------------------------------------------------------------------------

describe('queue drain on accept', () => {
  it('drains the pushed entry AND its older superseded entries, leaving nothing to re-push', async () => {
    // Several offline edits to the same note queue several entries; dedup pushes only the latest.
    // On accept, the older (superseded) entries must drain too — otherwise they re-push at a stale
    // baseVersion and the server forks them into spurious copies.
    const { db } = await import('../src/db/schema.js');
    const { mutateNotes } = await import('../src/db/mutate.js');

    const noteId = 'note-stale-drain-00000000-0000-4000-8000-000000000001';
    // Three edits, distinct createdAt (mutateNotes stamps ISO-now; force ordering explicitly).
    await db.notes.put(makeNote(noteId, 0, 'edit-3'));
    await db.syncQueue.bulkAdd([
      { id: crypto.randomUUID(), recordId: noteId, payload: makeNote(noteId, 0, 'edit-1'), baseVersion: 0, createdAt: '2026-06-15T12:00:00.001Z' },
      { id: crypto.randomUUID(), recordId: noteId, payload: makeNote(noteId, 0, 'edit-2'), baseVersion: 0, createdAt: '2026-06-15T12:00:00.002Z' },
      { id: crypto.randomUUID(), recordId: noteId, payload: makeNote(noteId, 0, 'edit-3'), baseVersion: 0, createdAt: '2026-06-15T12:00:00.003Z' },
    ]);

    let pushCount = 0;
    let pushedEntryCount = 0;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/sync/push')) {
        pushCount++;
        const body = JSON.parse(String(init!.body)) as { entries: unknown[] };
        pushedEntryCount += body.entries.length;
        return new Response(
          JSON.stringify({ results: [{ id: noteId, outcome: 'accepted', version: 1, syncSeq: 1 }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), { status: 200 });
    }) as typeof fetch;

    const storage: Record<string, string> = {};
    global.localStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = v; },
      removeItem: (k: string) => { delete storage[k]; },
    } as unknown as Storage;

    const { syncNow } = await import('../src/lib/syncEngine.js');
    syncNow(NB, '');
    await new Promise((r) => setTimeout(r, 50));

    // Only the latest entry was pushed (dedup), in a single push request...
    expect(pushCount).toBe(1);
    expect(pushedEntryCount).toBe(1);
    // ...and ALL three entries are now drained — nothing stale left to re-push.
    const remaining = await db.syncQueue.where('recordId').equals(noteId).toArray();
    expect(remaining).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3c: single-flight is per-notebook — another notebook is not dropped
// ---------------------------------------------------------------------------

describe('per-notebook single-flight', () => {
  it('a syncNow for a different notebook during an in-flight cycle is not dropped', async () => {
    // The single-flight guard must key on notebookId. A global gate (plus a deferred re-run
    // hardcoded to the in-flight notebook) silently swallows a concurrent syncNow for a different
    // notebook — its edits never reach the server.
    const { db } = await import('../src/db/schema.js');
    const NB_A = NB;
    const NB_B = 'nb-test-00000000-0000-4000-8000-0000000000b2' as NotebookId;

    const noteA = makeNote('note-a-00000000-0000-4000-8000-000000000001', 0, 'A');
    const noteB: Note = { ...makeNote('note-b-00000000-0000-4000-8000-000000000001', 0, 'B'), notebookId: NB_B };
    await db.notes.bulkPut([noteA, noteB]);
    await db.syncQueue.bulkAdd([
      { id: crypto.randomUUID(), recordId: noteA.id, payload: noteA, baseVersion: 0, createdAt: '2026-06-15T12:00:00.001Z' },
      { id: crypto.randomUUID(), recordId: noteB.id, payload: noteB, baseVersion: 0, createdAt: '2026-06-15T12:00:00.002Z' },
    ]);

    const pushedNotebooks: string[] = [];
    let releaseA!: () => void;
    const heldA = new Promise<void>((r) => (releaseA = r));
    let signalAEntered!: () => void;
    const aEntered = new Promise<void>((r) => (signalAEntered = r));

    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/sync/push')) {
        const body = JSON.parse(String(init!.body)) as { notebookId: string; entries: { id: string }[] };
        pushedNotebooks.push(body.notebookId);
        if (body.notebookId === NB_A) { signalAEntered(); await heldA; }
        return new Response(
          JSON.stringify({ results: body.entries.map((e) => ({ id: e.id, outcome: 'accepted', version: 1, syncSeq: 1 })) }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), { status: 200 });
    }) as typeof fetch;

    const storage: Record<string, string> = {};
    global.localStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = v; },
      removeItem: (k: string) => { delete storage[k]; },
    } as unknown as Storage;

    const { syncNow } = await import('../src/lib/syncEngine.js');
    syncNow(NB_A, '');
    await aEntered;                 // notebook A's push is in flight, held open
    syncNow(NB_B, '');             // different notebook — must run, not be swallowed
    await new Promise((r) => setTimeout(r, 30)); // let B push concurrently
    releaseA();
    await new Promise((r) => setTimeout(r, 50));

    expect(pushedNotebooks).toContain(NB_B);
  });
});

// ---------------------------------------------------------------------------
// Test 4: edit-while-syncing — edit during in-flight push is preserved
// ---------------------------------------------------------------------------

describe('edit-while-syncing', () => {
  it('an edit during an in-flight push survives the post-accept drain, pushes, and ends local==server', async () => {
    // The real silent-loss race (secSys trip-wire): the FIRST push is held open; the user edits
    // the note DURING that in-flight fetch, appending a NEW queue entry. The post-accept drain
    // must remove ONLY the pushed entry — not the in-flight edit. A blanket delete-by-recordId
    // empties the queue, marks the note synced at the server version, and the cycle's PULL (which
    // carries the server's PRE-edit state) then overwrites the local edit unguarded = SILENT LOSS.
    const { db } = await import('../src/db/schema.js');
    const { mutateNotes } = await import('../src/db/mutate.js');

    const noteId = 'note-edit-inflight-00000000-0000-4000-8000-000000000001';
    const FIRST = 'First version';
    const SECOND = 'Second version (edit while syncing)';

    const v1 = makeNote(noteId, 0, FIRST);
    await mutateNotes.put(v1); // queued with baseVersion 0

    // A tiny mock server: push accepts and advances version/syncSeq; pull replays current state.
    let serverState: SyncNote = makeSyncNote(makeNote(noteId, 0, FIRST), null, 0);
    let serverVersion = 0;
    let serverSeq = 0;
    const pushBodies: Array<{ id: string; baseVersion: number; title?: string }> = [];

    let pushCount = 0;
    let releaseFirstPush!: () => void;
    const firstPushHeld = new Promise<void>((r) => (releaseFirstPush = r));
    let signalFirstPushEntered!: () => void;
    const firstPushEntered = new Promise<void>((r) => (signalFirstPushEntered = r));

    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/sync/push')) {
        const body = JSON.parse(String(init!.body)) as {
          entries: Array<{ id: string; baseVersion: number; draft: { title?: string } }>;
        };
        const entry = body.entries[0]!;
        pushBodies.push({ id: entry.id, baseVersion: entry.baseVersion, title: entry.draft.title });
        pushCount++;
        if (pushCount === 1) {
          signalFirstPushEntered(); // we are now mid-flight
          await firstPushHeld; // hold open until the test inserts the in-flight edit
        }
        // Apply the accepted write to the mock server, then advance the sync position.
        serverVersion += 1;
        serverSeq += 1;
        serverState = makeSyncNote(
          makeNote(noteId, serverVersion, entry.draft.title ?? ''),
          null,
          serverSeq,
        );
        return new Response(
          JSON.stringify({
            results: [{ id: entry.id, outcome: 'accepted', version: serverVersion, syncSeq: serverSeq }],
          }),
          { status: 200 },
        );
      }
      // pull — replay server state when it is newer than the client cursor
      const cursor = Number(new URL(u, 'http://x').searchParams.get('cursor') ?? '0');
      const notes = serverState.syncSeq > cursor ? [serverState] : [];
      return new Response(
        JSON.stringify({ notes, nextCursor: serverState.syncSeq, hasMore: false }),
        { status: 200 },
      );
    }) as typeof fetch;

    const storage: Record<string, string> = {};
    global.localStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = v; },
      removeItem: (k: string) => { delete storage[k]; },
    } as unknown as Storage;

    const { syncNow } = await import('../src/lib/syncEngine.js');

    // Cycle 1: start the sync; the first push enters and holds open.
    syncNow(NB, '');
    await firstPushEntered;

    // THE EDIT, genuinely mid-flight — appends a new queue entry (higher createdAt).
    const v2 = { ...v1, title: SECOND };
    await mutateNotes.put(v2);

    // Release the held push; let cycle 1 finish (push-accept drain + pull).
    releaseFirstPush();
    await new Promise((r) => setTimeout(r, 50));

    // Cycle 2: flush the in-flight edit that must have survived the drain.
    syncNow(NB, '');
    await new Promise((r) => setTimeout(r, 50));

    const final = await db.notes.get(noteId as Note['id']);
    expect(final).toBeDefined();
    // The in-flight edit is not lost — neither to the drain nor to the cycle-1 pull guard.
    expect(final!.title).toBe(SECOND);
    // It pushed as an UPDATE on top of the accepted version, reaching server version 2.
    expect(final!.version).toBe(2);
    // The second push must carry the RECONCILED baseVersion (1), not the stale base (0) it was
    // authored at — otherwise the server treats it as a new-note INSERT and forks.
    expect(pushCount).toBe(2);
    expect(pushBodies[1]).toMatchObject({ baseVersion: 1, title: SECOND });
    // Queue fully drained — nothing lost, nothing stuck.
    const remaining = await db.syncQueue.where('recordId').equals(noteId).toArray();
    expect(remaining).toHaveLength(0);
  });
});
