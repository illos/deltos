import { useEffect, useState } from 'react';
import type { Note, NoteId, NotebookId } from '@deltos/shared';
import { getStore } from './store.js';

/**
 * Reactive store hooks — the ONLY way surfaces read persisted state. They expose plain values
 * (a Note, a number), never Dexie types or live handles, so a component never imports `db`/dexie and
 * the reactivity engine stays swappable behind {@link LocalStore.observeNote}/`observeQueueCount`.
 */

/** Reactively read a single note; `undefined` while loading or if it does not exist. */
export function useNote(id: NoteId | undefined): Note | undefined {
  const [note, setNote] = useState<Note | undefined>(undefined);
  useEffect(() => {
    if (!id) {
      setNote(undefined);
      return;
    }
    return getStore().observeNote(id, setNote);
  }, [id]);
  return note;
}

/** Reactively read all notes in a notebook, sorted by updatedAt descending. */
export function useNotes(notebookId: NotebookId): Note[] {
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => {
    return getStore().observeNotes(notebookId, setNotes);
  }, [notebookId]);
  return notes;
}

/**
 * Reactively read all trashed notes in a notebook.
 * TODO devSys2: replace the useEffect body with:
 *   return getStore().observeTrashedNotes(notebookId, setNotes);
 */
export function useTrashedNotes(notebookId: NotebookId): Note[] {
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => {
    void notebookId; void setNotes; // wired by devSys2
  }, [notebookId]);
  return notes;
}

/** Reactively read the outbound sync-queue depth (for the sync indicator). */
export function useSyncQueueCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => getStore().observeQueueCount(setCount), []);
  return count;
}
