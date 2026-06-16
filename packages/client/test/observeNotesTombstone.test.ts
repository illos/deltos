/**
 * observeNotes tombstone-filter + keep-mine resurrection (Part 2 / PIN-SYNC-3).
 *
 * Coverage gap closer (pilot ask): the CAV acceptance suite asserts the conflict-as-version DATA
 * (db.notes / noteVersions queried directly), but the LIST behavior — observeNotes hiding a
 * tombstone-state row and keep-mine bringing it back — is new code (dexieLocalStore.observeNotes
 * filter + resolveConflict keep-mine deletedAt-omit) that no test exercised. Surfaced by the prod
 * build fix that declared ClientNote.deletedAt. Node env + REAL timers (no fake-timer/liveQuery
 * hazard — see dexie-faketimers-deadlock).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Note, NoteId, NotebookId } from '@deltos/shared';
import { useAuthStore } from '../src/auth/store.js';
import { getStore } from '../src/db/store.js';
import { resolveConflict } from '../src/db/conflict.js';
import type { ClientNote } from '../src/db/schema.js';

const NB = 'nb-obs-00000000-0000-4000-8000-000000000001' as NotebookId;
const NOW = '2026-06-16T10:00:00.000Z';
const NOTE_ID = 'note-obs-0000-0000-4000-8000-000000000001' as NoteId;

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  useAuthStore.setState({ accountId: 'obs-acct-01', bearerToken: 'obs-tok', sessionState: 'active' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

/** One reactive snapshot of the notebook's notes: subscribe, resolve on the first emit, unsubscribe. */
function notesNow(): Promise<ClientNote[]> {
  return new Promise((resolve) => {
    const unsub = getStore().observeNotes(NB, (notes) => {
      unsub();
      resolve(notes);
    });
  });
}

/** Drive a real push-conflict so applyConflict produces the genuine tombstone/live state. */
async function pushConflict(localTitle: string, serverNote: Note | null) {
  const { db } = await import('../src/db/schema.js');
  const localEdit = makeNote(NOTE_ID, 1, localTitle);
  await db.notes.put(localEdit);
  await db.syncQueue.add({
    id: crypto.randomUUID(),
    recordId: NOTE_ID,
    payload: localEdit,
    baseVersion: 0,
    createdAt: NOW,
  });
  global.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/sync/push')) {
      return new Response(JSON.stringify({ results: [{ id: NOTE_ID, outcome: 'conflict', serverNote }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), { status: 200 });
  }) as typeof fetch;
  const { syncNow } = await import('../src/lib/syncEngine.js');
  syncNow(NB, '');
  await new Promise((r) => setTimeout(r, 100));
}

describe('observeNotes — tombstone-state filtering (PIN-SYNC-3)', () => {
  it('EXCLUDES a tombstone-conflict note (server-deleted) from the list', async () => {
    await pushConflict('My offline edit on a note deleted elsewhere', null /* server tombstone */);

    const { db } = await import('../src/db/schema.js');
    const row = (await db.notes.get(NOTE_ID)) as ClientNote | undefined;
    expect(row).toBeDefined();
    expect(row!.deletedAt).toBeTruthy(); // retained as tombstone-state
    expect(row!.hasConflict).toBe(true); // still badge-able via observeNote (single)

    const list = await notesNow();
    expect(list.find((n) => n.id === NOTE_ID)).toBeUndefined(); // hidden from the LIST
  });

  it('keep-mine RESURRECTS the tombstoned note back into the list', async () => {
    await pushConflict('My offline edit', null);

    // Precondition: hidden while a tombstone-state.
    expect((await notesNow()).find((n) => n.id === NOTE_ID)).toBeUndefined();

    await resolveConflict(NOTE_ID, 'keep-mine');

    const list = await notesNow();
    const resurrected = list.find((n) => n.id === NOTE_ID);
    expect(resurrected).toBeDefined();
    expect(resurrected!.title).toBe('My offline edit'); // the kept divergent content
    expect(resurrected!.deletedAt).toBeFalsy(); // tombstone cleared
    expect(resurrected!.hasConflict).toBeFalsy(); // resolved
  });

  it('a LIVE conflict note (server still exists) STAYS in the list — filter is tombstone-specific', async () => {
    await pushConflict('My divergent edit', makeNote(NOTE_ID, 5, 'Server version'));

    const { db } = await import('../src/db/schema.js');
    const row = (await db.notes.get(NOTE_ID)) as ClientNote | undefined;
    expect(row!.deletedAt).toBeFalsy();
    expect(row!.hasConflict).toBe(true);

    const list = await notesNow();
    expect(list.find((n) => n.id === NOTE_ID)).toBeDefined(); // a badged-but-live conflict still shows
  });
});
