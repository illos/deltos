/**
 * #32 — blank-note push deferral: a newly-created blank note (version=0) must never
 * enter the sync queue. The first content edit (title or body) arms the push.
 *
 * BD-1  Created-then-blank note is saved to the notes table but NOT enqueued
 * BD-2  Title-only note IS enqueued (title ≠ '' → has content, first-class)
 * BD-3  Blank content update on a synced note (version>0) IS enqueued
 *         (pilot scope: auto-trash for emptied synced notes is deferred; blank push preserves it)
 * BD-4  noteHasContent reflects the shared predicate contract
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { UNSYNCED_VERSION } from '@deltos/shared';
import type { Note, NotebookId } from '@deltos/shared';

const NB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NOTE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as Note['id'];

function makeEntry(noteId: string, baseVersion: number) {
  return {
    id: `entry-${Math.random()}`,
    recordId: noteId,
    payload: {} as Note,
    baseVersion,
    createdAt: '2026-06-18T00:00:00.000Z',
  };
}

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('BD-1 — newly created blank note never enqueues', () => {
  it('version=0 blank note is saved but NOT in syncQueue', async () => {
    const { db } = await import('../src/db/schema.js');
    const { dexieLocalStore } = await import('../src/db/dexieLocalStore.js');

    const blank: Note = {
      id: NOTE_ID, notebookId: NB_ID,
      title: '', body: [], properties: {},
      version: UNSYNCED_VERSION,
      createdAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:00.000Z',
      syncStatus: 'local-only',
    };

    await dexieLocalStore.putNoteAndEnqueue(blank, makeEntry(NOTE_ID, 0));

    expect(await db.notes.get(NOTE_ID)).toBeDefined();
    const q = await db.syncQueue.where('recordId').equals(NOTE_ID).toArray();
    expect(q).toHaveLength(0);
  });
});

describe('BD-2 — title-only note IS enqueued (first-class)', () => {
  it('version=0 note with non-empty title gets a queue entry', async () => {
    const { db } = await import('../src/db/schema.js');
    const { dexieLocalStore } = await import('../src/db/dexieLocalStore.js');

    const titleOnly: Note = {
      id: NOTE_ID, notebookId: NB_ID,
      title: 'Hello', body: [], properties: {},
      version: UNSYNCED_VERSION,
      createdAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:00.000Z',
      syncStatus: 'local-only',
    };

    await dexieLocalStore.putNoteAndEnqueue(titleOnly, makeEntry(NOTE_ID, 0));

    const q = await db.syncQueue.where('recordId').equals(NOTE_ID).toArray();
    expect(q).toHaveLength(1);
  });
});

describe('BD-3 — blank update on synced note IS enqueued (version>0)', () => {
  it('clearing a synced note to blank still queues (interim: blank persists on server)', async () => {
    const { db } = await import('../src/db/schema.js');
    const { dexieLocalStore } = await import('../src/db/dexieLocalStore.js');

    // Pre-seed as synced
    await db.notes.put({
      id: NOTE_ID, notebookId: NB_ID,
      title: 'Had content', body: [], properties: {},
      version: 3,
      createdAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:00.000Z',
      syncStatus: 'synced',
    });

    const blankUpdate: Note = {
      id: NOTE_ID, notebookId: NB_ID,
      title: '', body: [], properties: {},
      version: 3, // will be normalised by putNoteAndEnqueue to the existing row's version
      createdAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:01.000Z',
      syncStatus: 'pending',
    };

    await dexieLocalStore.putNoteAndEnqueue(blankUpdate, makeEntry(NOTE_ID, 3));

    const q = await db.syncQueue.where('recordId').equals(NOTE_ID).toArray();
    expect(q).toHaveLength(1);
  });
});

describe('BD-4 — noteHasContent predicate contract', () => {
  it('returns false for blank note', async () => {
    const { noteHasContent } = await import('../src/lib/noteContent.js');
    expect(noteHasContent({ title: '', body: [] })).toBe(false);
  });
  it('returns true for title-only note', async () => {
    const { noteHasContent } = await import('../src/lib/noteContent.js');
    expect(noteHasContent({ title: 'hi', body: [] })).toBe(true);
  });
  it('returns true for body-only note', async () => {
    const { noteHasContent } = await import('../src/lib/noteContent.js');
    expect(noteHasContent({ title: '', body: [{ type: 'paragraph' }] as Note['body'] })).toBe(true);
  });
});
