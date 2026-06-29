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
  await Promise.all([db.notes.clear(), db.syncQueue.clear(), db.notebooks.clear(), db.noteVersions.clear()]);
});

// We import the engine AFTER setting up fake-indexeddb so Dexie picks up the shim.
// Dynamic import also lets us re-import with a fresh module state for single-flight tests.

// NOTE: ids are real UUIDs — the push path now validates every entry against SyncPushEntrySchema
// (NoteId/NotebookId/BlockId are all `z.string().uuid()`), so a fake non-UUID fixture id would be
// quarantined client-side and never reach the mock server. Keep these valid.
const NB = '11111111-0000-4000-8000-000000000001' as NotebookId;
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

    const seedNoteId = '5f000000-0000-4000-8000-000000000001';

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
    useAuthStore.setState({ bearerToken: 'grant-tok-abc', accountId: 'auth-acct' });

    const seedId = 'a0000000-0000-4000-8000-000000000001';
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

    // F7 + test isolation: clear the in-memory session so it can't leak into other tests.
    useAuthStore.setState({ bearerToken: null, accountId: null });
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

    const noteId = 'b0000000-0000-4000-8000-000000000001';
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

describe('delete-vs-edit (PIN-SYNC-3): divergent edit retained as a conflict version, no fork', () => {
  it('a server-tombstone conflict retains the divergent edit as a version on the SAME id — no new note', async () => {
    const { db } = await import('../src/db/schema.js');
    const { useAuthStore } = await import('../src/auth/store.js');
    useAuthStore.setState({ accountId: 'acct-res', bearerToken: 'tok' }); // session for client-D6 scope

    const noteId = 'c0000000-0000-4000-8000-000000000001';
    const localEdit = makeNote(noteId, 1, 'My offline edit');
    await db.notes.put(localEdit);

    // Server tombstoned the note → push returns a conflict with serverNote: null (PIN-SYNC-3).
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/sync/push')) {
        return new Response(JSON.stringify({ results: [{ id: noteId, outcome: 'conflict', serverNote: null }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), { status: 200 });
    }) as typeof fetch;

    const storage: Record<string, string> = {};
    global.localStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = v; },
      removeItem: (k: string) => { delete storage[k]; },
    } as unknown as Storage;

    await db.syncQueue.add({ id: crypto.randomUUID(), recordId: noteId, payload: localEdit, baseVersion: 0, createdAt: NOW });

    const { syncNow } = await import('../src/lib/syncEngine.js');
    syncNow(NB, '');
    await new Promise((r) => setTimeout(r, 100));

    // SAME note id RETAINED as a tombstone-state with hasConflict (resurrectable via keep-mine) —
    // NOT hard-deleted, NO sibling fork note.
    const note = await db.notes.get(noteId as Note['id']);
    expect(note).toBeDefined();
    expect(note!.hasConflict).toBe(true);
    expect(note!.deletedAt).toBeTruthy();
    expect(await db.notes.count()).toBe(1); // no new-id fork

    // The divergent offline edit is retained as a conflict version on the SAME id (no-lost-edit).
    const versions = await db.noteVersions.where('noteId').equals(noteId).toArray();
    expect(versions).toHaveLength(1);
    expect(versions[0]!.kind).toBe('conflict');
    expect(versions[0]!.title).toBe('My offline edit');

    useAuthStore.setState({ accountId: null, bearerToken: null });
  });
});

// ---------------------------------------------------------------------------
// Test 3c: divergent edit retained as a conflict VERSION on a non-tombstone conflict (no-lost-edit,
// conflict-as-version). The divergent local edit is never lost and never a second note: it is
// retained as a noteVersions row on the SAME id; the server content is adopted live + hasConflict set.
// ---------------------------------------------------------------------------

describe('conflict retains the divergent edit as a version on the SAME id (no-lost-edit)', () => {
  it('a pending local edit hit by a non-tombstone server conflict is retained as a conflict version; server adopted live; no new note', async () => {
    const { db } = await import('../src/db/schema.js');
    const { useAuthStore } = await import('../src/auth/store.js');
    useAuthStore.setState({ accountId: 'acct-conf', bearerToken: 'tok' });

    const noteId = 'd0000000-0000-4000-8000-000000000001';
    const localEdit = makeNote(noteId, 1, 'My unsent edit');
    await db.notes.put(localEdit);
    await db.syncQueue.add({ id: crypto.randomUUID(), recordId: noteId, payload: localEdit, baseVersion: 0, createdAt: NOW });

    const serverNote = makeNote(noteId, 5, 'Server state from another device');

    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/sync/push')) {
        return new Response(JSON.stringify({ results: [{ id: noteId, outcome: 'conflict', serverNote }] }), { status: 200 });
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

    // SAME id adopts server state + hasConflict; NO sibling fork note in the list.
    const note = await db.notes.get(noteId as Note['id']);
    expect(note!.title).toBe('Server state from another device');
    expect(note!.hasConflict).toBe(true);
    expect(await db.notes.count()).toBe(1);

    // The unsent edit is retained as a conflict version — never lost.
    const versions = await db.noteVersions.where('noteId').equals(noteId).toArray();
    expect(versions).toHaveLength(1);
    expect(versions[0]!.title).toBe('My unsent edit');

    // The edit's queue entry was blanket-drained (its content now lives in the retained version).
    expect(await db.syncQueue.where('recordId').equals(noteId).count()).toBe(0);

    useAuthStore.setState({ accountId: null, bearerToken: null });
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

    const noteId = 'e0000000-0000-4000-8000-000000000001';
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
// Test 3c: account-scoped push — all queued entries pushed regardless of payload.notebookId
// ---------------------------------------------------------------------------

describe('account-scoped push: all queued entries regardless of payload notebookId', () => {
  it('syncNow pushes ALL queued entries — including those with a foreign payload notebookId', async () => {
    // After the Option-B server contract, the sync boundary is accountId (from the bearer token),
    // not notebookId. dedupeQueue must not filter by payload.notebookId — a note created on a
    // different device (foreign notebookId) must be pushed in the same batch.
    const { db } = await import('../src/db/schema.js');
    const NB_B = '22222222-0000-4000-8000-0000000000b2' as NotebookId;

    const noteA = makeNote('aa000000-0000-4000-8000-000000000001', 0, 'A');
    const noteB: Note = { ...makeNote('bb000000-0000-4000-8000-000000000001', 0, 'B'), notebookId: NB_B };
    await db.notes.bulkPut([noteA, noteB]);
    await db.syncQueue.bulkAdd([
      { id: crypto.randomUUID(), recordId: noteA.id, payload: noteA, baseVersion: 0, createdAt: '2026-06-15T12:00:00.001Z' },
      { id: crypto.randomUUID(), recordId: noteB.id, payload: noteB, baseVersion: 0, createdAt: '2026-06-15T12:00:00.002Z' },
    ]);

    const pushedIds: string[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/sync/push')) {
        const body = JSON.parse(String(init!.body)) as { entries: { id: string }[] };
        pushedIds.push(...body.entries.map((e) => e.id));
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
    syncNow(NB, '');
    await new Promise((r) => setTimeout(r, 50));

    // Both notes pushed in one sync cycle regardless of their payload.notebookId.
    expect(pushedIds).toContain(noteA.id);
    expect(pushedIds).toContain(noteB.id);
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

    const noteId = 'ed000000-0000-4000-8000-000000000001';
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
