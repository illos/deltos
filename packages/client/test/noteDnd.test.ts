/**
 * #79 desktop note→notebook DnD — the lazy chunk's logic. dragstart carries the note; a notebook row accepts
 * only note drags; drop moves the note to that notebook (null = All Notes/uncategorize) via the EXISTING
 * mutation; no-op on same-notebook / no-drag. (The chunk-NOT-in-entry split is verified at build.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Note, NotebookId } from '@deltos/shared';

vi.mock('../src/db/mutate.js', () => ({ mutateNotes: { put: vi.fn(async () => {}) } }));
vi.mock('../src/lib/syncEngine.js', () => ({ notifyQueueWrite: vi.fn() }));

import { startNoteDrag, allowNoteDrop, dropNoteOnNotebook, endNoteDrag } from '../src/lib/dnd/noteDnd.js';
import { mutateNotes } from '../src/db/mutate.js';
import { notifyQueueWrite } from '../src/lib/syncEngine.js';

const NB1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NB2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NotebookId;
const NOTE_MIME = 'application/x-deltos-note';

const makeNote = (notebookId: NotebookId | null): Note => ({
  id: 'note-1' as Note['id'], notebookId, title: 'T', properties: {}, body: [],
  version: 1, createdAt: 'x', updatedAt: 'x', syncStatus: 'synced',
});

function makeDt(types: string[] = []) {
  const store: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => { store[k] = v; },
    getData: (k: string) => store[k] ?? '',
    types,
    effectAllowed: '',
    dropEffect: '',
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (d: ReturnType<typeof makeDt>) => ({ dataTransfer: d, preventDefault: vi.fn() }) as any;

beforeEach(() => { vi.clearAllMocks(); endNoteDrag(); });

describe('noteDnd', () => {
  it('startNoteDrag sets the MIME note id + the move effect', () => {
    const d = makeDt();
    startNoteDrag(ev(d), makeNote(NB1));
    expect(d.getData(NOTE_MIME)).toBe('note-1');
    expect(d.effectAllowed).toBe('move');
  });

  it('allowNoteDrop accepts a note drag (preventDefault) and rejects non-note drags', () => {
    const e = ev(makeDt([NOTE_MIME]));
    expect(allowNoteDrop(e)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(allowNoteDrop(ev(makeDt(['text/plain'])))).toBe(false);
  });

  it('dropNoteOnNotebook moves the dragged note to the target notebook', async () => {
    startNoteDrag(ev(makeDt()), makeNote(NB1));
    await dropNoteOnNotebook(ev(makeDt()), NB2);
    expect(mutateNotes.put).toHaveBeenCalledWith(expect.objectContaining({ id: 'note-1', notebookId: NB2 }));
    expect(notifyQueueWrite).toHaveBeenCalledWith(NB2);
  });

  it('dropping onto All Notes (null) uncategorizes the note', async () => {
    startNoteDrag(ev(makeDt()), makeNote(NB1));
    await dropNoteOnNotebook(ev(makeDt()), null);
    expect(mutateNotes.put).toHaveBeenCalledWith(expect.objectContaining({ notebookId: null }));
    expect(notifyQueueWrite).toHaveBeenCalledWith(null);
  });

  it('is a NO-OP when dropped on the note\'s current notebook', async () => {
    startNoteDrag(ev(makeDt()), makeNote(NB1));
    await dropNoteOnNotebook(ev(makeDt()), NB1);
    expect(mutateNotes.put).not.toHaveBeenCalled();
  });

  it('is a NO-OP with no active drag', async () => {
    await dropNoteOnNotebook(ev(makeDt()), NB1);
    expect(mutateNotes.put).not.toHaveBeenCalled();
  });
});
