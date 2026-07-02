import type { NotebookId } from '@deltos/shared';
import { mutateNotes } from '../../db/mutate.js';
import { notifyQueueWrite } from '../syncEngine.js';
import { showToast } from '../toastEvents.js';

/**
 * Mobile file-picker → file-note creation (file-notes.md §5.1) — the touch sibling of the desktop
 * list-drop (`dnd/fileNoteDnd.dropFilesOnList`). The Deck's navigation loadout hosts a hidden
 * `<input type="file" multiple>`; its selected files land here, one file note per file, into the
 * CURRENT notebook (createFileNote reads it via getDefaultNotebookId — null = All Notes).
 *
 * LAZY-LOADED: a separate dynamically-imported chunk (see ./useFilePickerUpload), so this module — and
 * the createFileNote upload path it reaches (blobClient / direct-to-R2) — code-splits OUT of the mobile
 * first-load / entry bundle (perf standing value + [[plugins-lazy-past-first-paint]] / gate FN-8). Never
 * static-imported by the Deck button; the button only wires the input and defers the heavy work to here.
 */
export async function createFileNotesFromPicker(files: File[]): Promise<void> {
  if (files.length === 0) return;
  let created = 0;
  let notebookId: NotebookId | null = null;
  await Promise.all(
    files.map(async (file) => {
      try {
        const note = await mutateNotes.createFileNote(file);
        notebookId = note.notebookId;
        created += 1;
      } catch (err) {
        // A deliberate Cancel (large-file direct upload) aborts the XHR → AbortError. That's not a failure:
        // the transient progress indicator already disappeared, so stay silent. Any real failure (network,
        // R2 checksum reject, quota) surfaces the per-file toast (no orphan note — upload-first).
        if ((err as { name?: string } | null)?.name === 'AbortError') return;
        showToast(`Couldn't add "${file.name}"`);
      }
    }),
  );
  if (created > 0) {
    notifyQueueWrite(notebookId);
    showToast(created === 1 ? 'File added' : `${created} files added`);
  }
}
