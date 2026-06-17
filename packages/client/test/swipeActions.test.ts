/**
 * Swipe-actions Lane-1 data-layer regression tests.
 *
 *   SA-T3 duplicate → new id, both rows present, copied content, enqueued as a fresh upsert.
 *
 * SA-T1 (delete), SA-T2 (undo), SA-T4 (delete-while-pending-edit) are HELD: a user pivot reshaped
 * delete from the `deletedAt` tombstone model to TRASH-AS-VERSION (delete = a trash-tagged version,
 * list filters by tag; restore clears the tag). The softDelete/restore scaffolding in mutate.ts +
 * the SyncQueueEntry.op tag are kept (not reverted) pending the settled design; their regression
 * tests will be (re)written against the trash-as-version model. Duplicate is unaffected by the pivot.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Note, NoteId, NotebookId } from '@deltos/shared';
import { useAuthStore } from '../src/auth/store.js';
import { getStore } from '../src/db/store.js';
import { mutateNotes } from '../src/db/mutate.js';
import type { ClientNote } from '../src/db/schema.js';

const NB = 'nb-sa-00000000-0000-4000-8000-000000000001' as NotebookId;
const NOTE_ID = 'note-sa-0000-0000-4000-8000-000000000001' as NoteId;
const NOW = '2026-06-17T10:00:00.000Z';

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all([db.notes.clear(), db.syncQueue.clear(), db.notebooks.clear(), db.noteVersions.clear()]);
  useAuthStore.setState({ accountId: 'sa-acct', bearerToken: 'sa-tok', sessionState: 'active' });
});

afterEach(() => vi.restoreAllMocks());

function makeNote(id: string, version: number, title: string): Note {
  return {
    id: id as NoteId, notebookId: NB, title, properties: {}, body: [],
    version, createdAt: NOW, updatedAt: NOW, syncStatus: 'synced',
  };
}

/** One reactive snapshot of the notebook's visible notes (observeNotes filters tombstones). */
function notesNow(): Promise<ClientNote[]> {
  return new Promise((resolve) => {
    const unsub = getStore().observeNotes(NB, (notes) => { unsub(); resolve(notes); });
  });
}

async function seedSynced(version = 1, title = 'My note') {
  const { db } = await import('../src/db/schema.js');
  const note = makeNote(NOTE_ID, version, title);
  await db.notes.put(note);
  return note;
}

describe('SA-T3 — duplicate: new id, both rows, fresh upsert', () => {
  it('creates a new note (new id, copied content, version 0) — both rows present + enqueued', async () => {
    const { db } = await import('../src/db/schema.js');
    const note = await seedSynced(3, 'Original');

    const dup = await mutateNotes.duplicate(note);

    expect(dup.id).not.toBe(NOTE_ID);
    expect(dup.title).toBe('Original');                         // copied content
    expect(dup.version).toBe(0);                                // fresh note → server INSERT
    expect(await db.notes.count()).toBe(2);                     // both rows present
    const list = await notesNow();
    expect(list.map((n) => n.id).sort()).toEqual([NOTE_ID, dup.id].sort());
    const dupEntries = await db.syncQueue.where('recordId').equals(dup.id).toArray();
    expect(dupEntries).toHaveLength(1);
    expect(dupEntries[0].op).toBeUndefined();                   // upsert (absent op)
    expect(dupEntries[0].baseVersion).toBe(0);                  // INSERT
  });
});
