import type { Note, NotebookId } from '@deltos/shared';
import type { DragEvent } from 'react';
import { mutateNotes } from '../../db/mutate.js';
import { notifyQueueWrite } from '../syncEngine.js';

/**
 * Desktop note→notebook drag-and-drop (#79) — native HTML5 DnD, ZERO dependency. LAZY-LOADED: this module is
 * a separate dynamically-imported chunk (see ./useNoteDnd), desktop-only, never in the entry/editor bundle or
 * on mobile or the note-writing path (perf standing value + [[plugins-lazy-past-first-paint]]).
 *
 * The dragged note is held in a module-level singleton: dragstart + drop share this lazy module, so we keep
 * the full Note object (which dataTransfer can't carry) without a store refetch. A MIME marker on the
 * dataTransfer lets notebook rows accept ONLY note drops.
 */
const NOTE_MIME = 'application/x-deltos-note';

let draggedNote: Note | null = null;

export function startNoteDrag(e: DragEvent, note: Note): void {
  draggedNote = note;
  e.dataTransfer.setData(NOTE_MIME, note.id);
  e.dataTransfer.effectAllowed = 'move';
}

export function endNoteDrag(): void {
  draggedNote = null;
}

/** Whether the current drag carries a deltos note (so notebook rows highlight/accept only note drops). */
export function isNoteDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(NOTE_MIME);
}

/** A notebook row hovered during a note drag → ALLOW the drop (preventDefault). True iff it's a note drag. */
export function allowNoteDrop(e: DragEvent): boolean {
  if (!isNoteDrag(e)) return false;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  return true;
}

/**
 * Drop the dragged note onto a notebook (null = All Notes → uncategorize) → move via the EXISTING mutation.
 * No-op if there's no note or it's already in that notebook.
 */
export async function dropNoteOnNotebook(e: DragEvent, notebookId: NotebookId | null): Promise<void> {
  e.preventDefault();
  const note = draggedNote;
  draggedNote = null;
  if (!note || note.notebookId === notebookId) return;
  await mutateNotes.put({ ...note, notebookId });
  notifyQueueWrite(notebookId);
}
