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

function syncNotebook(id: string, _isDefault?: boolean, deletedAt: string | null = null): SyncNotebook {
  return {
    id: id as NotebookId,
    accountId: 'acct-1',
    name: 'Notes',
    defaultCollectionView: 'list',
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

describe('mergeNotebooks — pointer reconcile (#52 + #59 All Notes)', () => {
  it('STALE pointer (does not resolve to a live notebook) → falls back to null (All Notes)', async () => {
    const { mergeNotebooks } = await import('../src/lib/syncEngine.js');
    await setCurrent('nb-stale-legacy-per-device-id'); // a Phase-1 / never-synced id — no local row
    await mergeNotebooks([syncNotebook(CANON, true)]);
    expect(await currentId()).toBeNull(); // fell back to All Notes — no stored default any more
  });

  it('null pointer (All Notes) → stays null (All Notes is always valid, no auto-adopt)', async () => {
    const { mergeNotebooks } = await import('../src/lib/syncEngine.js');
    await mergeNotebooks([syncNotebook(CANON, true)]);
    expect(await currentId()).toBeNull(); // null = All Notes = valid; never auto-selected away from it
  });

  it('deleted current notebook → falls back to null (All Notes)', async () => {
    const { mergeNotebooks } = await import('../src/lib/syncEngine.js');
    const dead = 'nb-dead-00000000-0000-4000-8000-000000000009';
    await setCurrent(dead);
    // The pull delivers the (now-deleted) current AND the live default.
    await mergeNotebooks([syncNotebook(dead, false, NOW), syncNotebook(CANON, true)]);
    expect(await currentId()).toBeNull(); // fell back to All Notes
  });

  it('EXACT COUNT: merging N server notebooks yields exactly N rows in IDB (client never fabricates extras)', async () => {
    const { db } = await import('../src/db/schema.js');
    const { mergeNotebooks } = await import('../src/lib/syncEngine.js');
    const work = 'nb-work-00000000-0000-4000-8000-000000000002';
    // isDefault is gone (#61) — the no-duplicate invariant is structural. Assert exact count instead.
    await mergeNotebooks([syncNotebook(CANON), syncNotebook(work)]);
    const live = (await db.notebooks.toArray()).filter((n) => n.deletedAt === null);
    expect(live.map((n) => n.id).sort()).toEqual([CANON, work].sort());
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

describe('GATE — create → EDIT → sync → note STAYS PUT (does not vanish) (#52 + #59)', () => {
  it('a note stamped with a stale notebookId, re-stamped to null by sync, stays VISIBLE in All Notes', async () => {
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

    // The sync round-trip: the server (#58) now re-homes orphaned notes to null (uncategorized / All Notes).
    // The pull returns the note re-stamped to null + the canonical notebook.
    const reStamped: SyncNote = { ...local, notebookId: null, syncStatus: 'synced', deletedAt: null, syncSeq: 2 };
    await mergePull([reStamped], 'nbr-acct');
    await mergeNotebooks([syncNotebook(CANON, true)]);

    // After reconcile: note is null (All Notes) + pointer fell back to null (All Notes).
    // All Notes (currentId=null) is unfiltered — note IS visible. This is the hard deploy gate.
    const storedNote = await db.notes.get(noteId);
    expect(storedNote?.notebookId).toBeNull(); // server re-homed to uncategorized
    expect(await currentId()).toBeNull(); // fell back to All Notes (no stored default)
    // Both null → note is visible in All Notes (HomeView with notebookId=null shows all notes).
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
    await mergePull([echoed], 'nbr-acct');
    await mergeNotebooks([syncNotebook(BOOKS, false), syncNotebook(CANON, true)]);

    const storedNote = await db.notes.get(noteId);
    expect(storedNote?.notebookId).toBe(BOOKS); // unchanged — custom path untouched
    expect(await currentId()).toBe(BOOKS); // pointer kept on the custom notebook (not yanked to default)
  });
});
