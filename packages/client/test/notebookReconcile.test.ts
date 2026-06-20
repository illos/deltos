/**
 * #52 P0 — notebook-pointer reconcile (adopt-canonical) + the create→EDIT→sync STAYS-PUT gate.
 *
 * Root cause: the client kept a STALE/legacy currentNotebookId (a Phase-1 per-device default id, or any
 * id that never synced as a notebook row). It does not resolve to a live synced notebook, so new notes
 * were stamped with that non-canonical id; on edit+sync the SERVER reassigns the note to the account's
 * canonical default → the note leaves the (stale-id) current-notebook view → "vanishes". PRE-HISTORY
 * (the buggy reconcile is from #18/#28; #45 capture never writes notebookId).
 *
 * Fix: mergeNotebooks reconciles the pointer — if currentNotebookId doesn't resolve to a LIVE local
 * notebook, adopt the canonical default. A pointer that already resolves (default OR a user's chosen
 * notebook) is kept (never yank a user off a notebook they're legitimately viewing).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { NotebookId, SyncNotebook, SyncNote, Note } from '@deltos/shared';

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all([db.notes.clear(), db.syncQueue.clear(), db.notebooks.clear(), db.noteVersions.clear(), db.deviceState.clear()]);
  const { useNotebookStore } = await import('../src/lib/notebookStore.js');
  useNotebookStore.setState({ _ready: true, currentNotebookId: null });
});

const NOW = '2026-06-20T12:00:00.000Z';
const CANON = 'nb-canon-00000000-0000-4000-8000-000000000001' as NotebookId;

function syncNotebook(id: string, isDefault: boolean, deletedAt: string | null = null): SyncNotebook {
  return {
    id: id as NotebookId,
    accountId: 'acct-1',
    name: 'Notes',
    defaultCollectionView: 'list',
    isDefault,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt,
    syncSeq: 1,
  } as SyncNotebook;
}

async function setCurrent(id: string) {
  const { useNotebookStore } = await import('../src/lib/notebookStore.js');
  await useNotebookStore.getState().setCurrentNotebook(id as NotebookId);
}
async function currentId(): Promise<string | null> {
  const { useNotebookStore } = await import('../src/lib/notebookStore.js');
  return useNotebookStore.getState().currentNotebookId;
}

describe('mergeNotebooks — adopt-canonical pointer reconcile (#52)', () => {
  it('STALE pointer (does not resolve to a live notebook) → adopts the canonical default', async () => {
    const { mergeNotebooks } = await import('../src/lib/syncEngine.js');
    await setCurrent('nb-stale-legacy-per-device-id'); // a Phase-1 / never-synced id — no local row
    await mergeNotebooks([syncNotebook(CANON, true)]);
    expect(await currentId()).toBe(CANON); // reconciled to the canonical default
  });

  it('null pointer (fresh device) → adopts the default (existing behavior preserved)', async () => {
    const { mergeNotebooks } = await import('../src/lib/syncEngine.js');
    await mergeNotebooks([syncNotebook(CANON, true)]);
    expect(await currentId()).toBe(CANON);
  });

  it('deleted current notebook → adopts the default', async () => {
    const { mergeNotebooks } = await import('../src/lib/syncEngine.js');
    const dead = 'nb-dead-00000000-0000-4000-8000-000000000009';
    await setCurrent(dead);
    // The pull delivers the (now-deleted) current AND the live default.
    await mergeNotebooks([syncNotebook(dead, false, NOW), syncNotebook(CANON, true)]);
    expect(await currentId()).toBe(CANON);
  });

  it('EXACTLY ONE default: merging a server set with one isDefault yields exactly one local default row (client renders default strictly from server isDefault, never fabricates a 2nd)', async () => {
    const { db } = await import('../src/db/schema.js');
    const { mergeNotebooks } = await import('../src/lib/syncEngine.js');
    const work = 'nb-work-00000000-0000-4000-8000-000000000002';
    // The server (partial unique index notebooks_oneDefault) can only ever send ONE isDefault=1.
    await mergeNotebooks([syncNotebook(CANON, true), syncNotebook(work, false)]);
    const defaults = (await db.notebooks.toArray()).filter((n) => n.isDefault && n.deletedAt === null);
    expect(defaults.map((n) => n.id)).toEqual([CANON]); // exactly one, and it's the server's canonical
  });

  it('IDEMPOTENT: a pointer that RESOLVES to a live notebook (a user-chosen one) is KEPT, not yanked to default', async () => {
    const { mergeNotebooks } = await import('../src/lib/syncEngine.js');
    const work = 'nb-work-00000000-0000-4000-8000-000000000002';
    // Both the user's 'Work' notebook and the default arrive live; the user is currently on 'Work'.
    await mergeNotebooks([syncNotebook(work, false), syncNotebook(CANON, true)]);
    await setCurrent(work);
    await mergeNotebooks([syncNotebook(work, false), syncNotebook(CANON, true)]); // a later pull
    expect(await currentId()).toBe(work); // kept — NOT reconciled to default
  });
});

describe('GATE — create → EDIT → sync → note STAYS PUT (does not vanish) (#52)', () => {
  it('a note stamped with a stale notebookId, re-stamped to canonical by sync, stays VISIBLE (notebookId === currentNotebookId)', async () => {
    const { db } = await import('../src/db/schema.js');
    const { mergeNotebooks, mergePull } = await import('../src/lib/syncEngine.js');

    // Pre-fix repro: the device is on a STALE pointer; a note was created+edited under it.
    const STALE = 'nb-stale-00000000-0000-4000-8000-00000000000a';
    await setCurrent(STALE);
    const noteId = 'note-52-00000000-0000-4000-8000-000000000001';
    const local: Note = {
      id: noteId as Note['id'],
      notebookId: STALE as NotebookId,
      title: 'Edited note',
      properties: {},
      body: [],
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      syncStatus: 'pending',
    };
    await db.notes.put(local); // seeded directly (no pending queue entry → pull applies the server re-stamp)

    // The sync round-trip: the server reassigned the orphaned notebookId to the canonical default and the
    // pull returns the note re-stamped + the canonical notebook.
    const reStamped: SyncNote = { ...local, notebookId: CANON, syncStatus: 'synced', deletedAt: null, syncSeq: 2 };
    await mergePull([reStamped]);
    await mergeNotebooks([syncNotebook(CANON, true)]);

    // The note moved to the canonical notebook AND the pointer followed → HomeView (notebookId ===
    // currentNotebookId) still shows it. WITHOUT the reconcile fix, currentNotebookId would stay STALE
    // while the note sits under CANON → it vanishes from the view. This is the hard deploy gate.
    const storedNote = await db.notes.get(noteId);
    expect(storedNote?.notebookId).toBe(CANON);
    expect(await currentId()).toBe(CANON);
    expect(storedNote!.notebookId).toBe(await currentId()); // visible in the current-notebook list
  });

  it('REGRESSION GUARD: a note in a CUSTOM notebook stays put through sync (the fix must not disturb the proven-fine custom path)', async () => {
    const { db } = await import('../src/db/schema.js');
    const { mergeNotebooks, mergePull } = await import('../src/lib/syncEngine.js');

    // The user's custom notebook is a consistent synced id (the proven-fine path). It must NOT be
    // reassigned to the default, and the pointer must NOT be yanked off it.
    const BOOKS = 'nb-books-00000000-0000-4000-8000-000000000003' as NotebookId;
    await mergeNotebooks([syncNotebook(BOOKS, false), syncNotebook(CANON, true)]);
    await setCurrent(BOOKS);

    const noteId = 'note-52-00000000-0000-4000-8000-000000000002';
    const local: Note = {
      id: noteId as Note['id'],
      notebookId: BOOKS,
      title: 'A book note',
      properties: {},
      body: [],
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      syncStatus: 'pending',
    };
    await db.notes.put(local);

    // Sync round-trip: the server KEEPS the resolvable custom notebookId (no reassign), pull echoes it.
    const echoed: SyncNote = { ...local, syncStatus: 'synced', deletedAt: null, syncSeq: 2 };
    await mergePull([echoed]);
    await mergeNotebooks([syncNotebook(BOOKS, false), syncNotebook(CANON, true)]);

    const storedNote = await db.notes.get(noteId);
    expect(storedNote?.notebookId).toBe(BOOKS); // unchanged — custom path untouched
    expect(await currentId()).toBe(BOOKS); // pointer kept on the custom notebook (not yanked to default)
  });
});
