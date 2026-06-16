/**
 * Editor → store → list wiring tests.
 *
 * These cover the gap the Phase-1 dogfood found: the autosave path (editor onSave →
 * mutateNotes.put) and the reactive list (observeNotes → HomeView) were NOT exercised
 * together by the server-side Tier-A suite. These tests close that gap at the store
 * layer (fake-indexeddb, no React) so a regression in any part of the chain is caught
 * before the next recorded capstone run.
 *
 * Covered:
 *   - observeNotes fires with initial state on subscription (empty → correct seed)
 *   - mutateNotes.put (the autosave codepath) writes the note to IndexedDB
 *   - observeNotes reacts to a new note written via mutateNotes.put
 *   - observeNotes sorts notes by updatedAt descending (newest first in list)
 *   - observeNotes scopes by notebookId (cross-notebook isolation)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { Note, NotebookId } from '@deltos/shared';

// The Dexie instance is a module singleton — clear between tests for isolation.
beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all([db.notes.clear(), db.syncQueue.clear()]);
});

const NB = '11111111-1111-4111-8111-111111111111' as NotebookId;
const NB2 = '22222222-2222-4222-8222-222222222222' as NotebookId;

function makeNote(id: string, notebookId: NotebookId, title: string, updatedAt: string): Note {
  return {
    id: id as Note['id'],
    notebookId,
    title,
    properties: {},
    body: [],
    version: 0,
    createdAt: '2026-06-16T00:00:00.000Z',
    updatedAt,
    syncStatus: 'local-only',
  };
}

/** Subscribe to observeNotes and collect the first emission. */
async function firstEmission(notebookId: NotebookId): Promise<Note[]> {
  const { getStore } = await import('../src/db/store.js');
  return new Promise((resolve) => {
    const unsub = getStore().observeNotes(notebookId, (notes) => {
      unsub();
      resolve(notes);
    });
  });
}

/** Subscribe to observeNotes and collect the first TWO distinct emissions. */
async function twoEmissions(notebookId: NotebookId): Promise<[Note[], Note[]]> {
  const { getStore } = await import('../src/db/store.js');
  return new Promise((resolve) => {
    const emissions: Note[][] = [];
    const unsub = getStore().observeNotes(notebookId, (notes) => {
      emissions.push(notes);
      if (emissions.length === 2) {
        unsub();
        resolve([emissions[0], emissions[1]]);
      }
    });
  });
}

describe('observeNotes — initial state', () => {
  it('fires with empty array when no notes exist for the notebookId', async () => {
    const notes = await firstEmission(NB);
    expect(notes).toEqual([]);
  });

  it('fires with the seeded note when one exists on subscription', async () => {
    const { db } = await import('../src/db/schema.js');
    const note = makeNote('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NB, 'Hello', '2026-06-16T10:00:00.000Z');
    await db.notes.put(note);

    const notes = await firstEmission(NB);
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(note.id);
    expect(notes[0].title).toBe('Hello');
  });
});

describe('mutateNotes.put → observeNotes (autosave → list wiring)', () => {
  it('a note written via mutateNotes.put appears in observeNotes', async () => {
    const { mutateNotes } = await import('../src/db/mutate.js');
    const note = makeNote('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', NB, 'Typed title', '2026-06-16T11:00:00.000Z');

    // Start observing BEFORE the write (the reactive update must fire).
    const [initial, afterWrite] = await Promise.all([
      twoEmissions(NB),
      // Write after a tiny delay so the subscription is established first.
      new Promise<void>(resolve => setTimeout(resolve, 10)).then(() => mutateNotes.put(note)),
    ]);

    const [first, second] = initial;
    expect(first).toHaveLength(0);   // empty before write
    expect(second).toHaveLength(1);  // appears after write
    expect(second[0].title).toBe('Typed title');
  });

  it('autosave update (put with new title) replaces the old entry in the list', async () => {
    const { mutateNotes } = await import('../src/db/mutate.js');
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as Note['id'];

    // Initial empty note (NewNote creates this).
    const emptyNote = makeNote(id, NB, '', '2026-06-16T12:00:00.000Z');
    await mutateNotes.put(emptyNote);

    // Autosave: editor fires onChange -> persistUpdate -> onSave -> mutateNotes.put with title.
    const savedNote: Note = { ...emptyNote, title: 'My note', syncStatus: 'pending', updatedAt: '2026-06-16T12:00:01.000Z' };
    await mutateNotes.put(savedNote);

    const notes = await firstEmission(NB);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('My note');
  });
});

describe('observeNotes — sort order', () => {
  it('returns notes sorted by updatedAt descending (newest first)', async () => {
    const { db } = await import('../src/db/schema.js');
    const older = makeNote('dddddddd-dddd-4ddd-8ddd-dddddddddddd', NB, 'Older', '2026-06-16T09:00:00.000Z');
    const newer = makeNote('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', NB, 'Newer', '2026-06-16T10:00:00.000Z');
    await db.notes.put(older);
    await db.notes.put(newer);

    const notes = await firstEmission(NB);
    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe('Newer');
    expect(notes[1].title).toBe('Older');
  });
});

describe('observeNotes — notebookId scoping', () => {
  it('does not include notes from a different notebook', async () => {
    const { db } = await import('../src/db/schema.js');
    const nb1Note = makeNote('ffffffff-ffff-4fff-8fff-ffffffffffff', NB, 'Notebook 1', '2026-06-16T10:00:00.000Z');
    const nb2Note = makeNote('00000000-0000-4000-8000-000000000002', NB2, 'Notebook 2', '2026-06-16T10:00:00.000Z');
    await db.notes.put(nb1Note);
    await db.notes.put(nb2Note);

    const notesNb1 = await firstEmission(NB);
    expect(notesNb1).toHaveLength(1);
    expect(notesNb1[0].title).toBe('Notebook 1');

    const notesNb2 = await firstEmission(NB2);
    expect(notesNb2).toHaveLength(1);
    expect(notesNb2[0].title).toBe('Notebook 2');
  });
});
