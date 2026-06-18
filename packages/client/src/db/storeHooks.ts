import { useEffect, useState } from 'react';
import type { Note, NoteId } from '@deltos/shared';
import { getStore } from './store.js';
import type { NotebookRow } from './schema.js';
import { useNotebookStore } from '../lib/notebookStore.js';

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

/** Reactively read all account notes, sorted by updatedAt descending. */
export function useNotes(): Note[] {
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => getStore().observeNotes(setNotes), []);
  return notes;
}

/** Reactively read all account trashed notes. */
export function useTrashedNotes(): Note[] {
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => getStore().observeTrashedNotes(setNotes), []);
  return notes;
}

/** Reactively read the outbound sync-queue depth (for the sync indicator). */
export function useSyncQueueCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => getStore().observeQueueCount(setCount), []);
  return count;
}

/** Reactively read all live (non-deleted) notebooks, sorted by name. */
export function useNotebooks(): NotebookRow[] {
  const [notebooks, setNotebooks] = useState<NotebookRow[]>([]);
  useEffect(() => getStore().observeNotebooks(setNotebooks), []);
  return notebooks;
}

/** Reactively read the current notebook row (null while loading or unset). */
export function useCurrentNotebook(): NotebookRow | null {
  const currentNotebookId = useNotebookStore((s) => s.currentNotebookId);
  const [notebook, setNotebook] = useState<NotebookRow | null>(null);
  useEffect(() => {
    if (!currentNotebookId) { setNotebook(null); return; }
    return getStore().observeNotebooks((notebooks) => {
      setNotebook(notebooks.find((nb) => nb.id === currentNotebookId) ?? null);
    });
  }, [currentNotebookId]);
  return notebook;
}
