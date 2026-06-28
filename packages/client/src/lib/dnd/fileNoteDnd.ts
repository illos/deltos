import type { DragEvent } from 'react';
import type { NotebookId } from '@deltos/shared';
import { mutateNotes } from '../../db/mutate.js';
import { notifyQueueWrite } from '../syncEngine.js';
import { showToast } from '../toastEvents.js';

/**
 * Desktop list-drop → file-note creation (file-notes.md §5.1) — the MIRROR of editor-drop = inline block.
 * Dropping OS file(s) on the notes-LIST pane (not inside an open editor) creates one file note per file and
 * STAYS on the list; the new pills appear reactively via observeNotes. LAZY-LOADED: a separate dynamically-
 * imported chunk (see ./useFileNoteDnd), desktop-only, never in the entry/editor bundle or on mobile or the
 * note-writing path (perf standing value + [[plugins-lazy-past-first-paint]] / gate FN-8).
 *
 * Native HTML5 DnD, zero dependency. An OS file drag advertises the `Files` type on the dataTransfer, which
 * is how the list accepts ONLY external-file drops (a note→notebook drag carries the deltos-note MIME instead,
 * so the two drop intents never cross).
 */

/** True iff the current drag carries external OS file(s) (so the list highlights/accepts only file drops). */
export function isFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

/** The list pane hovered during a file drag → ALLOW the drop (copy effect). True iff it's a file drag. */
export function allowFileDrop(e: DragEvent): boolean {
  if (!isFileDrag(e)) return false;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  return true;
}

/**
 * Drop OS file(s) on the notes-list pane → a file note per file, into the current notebook (createFileNote
 * reads it). Uploads run in parallel; each file's failure is isolated (abort + toast for THAT file, §5.1 —
 * no orphan note), so one bad file never sinks the rest. Notifies the sync trigger once so the new notes push.
 */
export async function dropFilesOnList(e: DragEvent): Promise<void> {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files);
  if (files.length === 0) return;
  let created = 0;
  let notebookId: NotebookId | null = null;
  await Promise.all(
    files.map(async (file) => {
      try {
        const note = await mutateNotes.createFileNote(file);
        notebookId = note.notebookId;
        created += 1;
      } catch {
        showToast(`Couldn't add "${file.name}"`);
      }
    }),
  );
  if (created > 0) {
    notifyQueueWrite(notebookId);
    showToast(created === 1 ? 'File added' : `${created} files added`);
  }
}
