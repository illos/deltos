import { useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { Note } from '@deltos/shared';
import { NoteIdSchema } from '@deltos/shared';
import { useNote } from '../db/storeHooks.js';
import { mutateNotes } from '../db/mutate.js';
import { notifyQueueWrite } from '../lib/syncEngine.js';
import { NoteEditor } from '../editor/NoteEditor.js';
import { resolveNoteView } from '../editor/views.js';
import { ConflictView } from '../components/ConflictView.js';
import type { ClientNote } from '../db/schema.js';

/**
 * Loads a note by ID through the LocalStore seam and renders the appropriate view.
 *
 * useNote is reactive: when Stream B's sync engine writes an incoming server update via the store,
 * this component re-renders automatically — without polling or manual refresh. It reads through the
 * store hook, never Dexie directly, so the persistence engine stays swappable.
 *
 * View resolution: note → resolveNoteView(note) → render. Phase 1 always resolves to the
 * block editor (NoteEditor / ProseMirror). Phase 2 can register full-view descriptors for
 * notebook-capability-specific rendering without changing this route (see editor/views.ts).
 */
export function NoteRoute() {
  const { id } = useParams<{ id: string }>();

  // Stable save handler: write to Dexie then kick Stream B's debounced sync.
  const handleSave = useCallback(async (note: Note) => {
    await mutateNotes.put(note);
    notifyQueueWrite(note.notebookId);
  }, []);

  const noteId = id ? NoteIdSchema.safeParse(id) : null;

  // Reactive read through the store seam; undefined for an invalid id (guarded below) or while loading.
  const note = useNote(noteId?.success ? noteId.data : undefined);

  if (!noteId?.success) {
    return (
      <div className="route-error">
        <p>Invalid note URL.</p>
      </div>
    );
  }

  // Render the editor chrome immediately (render-before-data). IndexedDB resolves in < 1 ms;
  // the brief undefined state shows the chrome with no content rather than a spinner.
  if (note === undefined) {
    return <div className="editor editor--loading" />;
  }

  const clientNote = note as ClientNote;

  if (clientNote.hasConflict) {
    return (
      <>
        <Link to="/" className="editor__back">← Notes</Link>
        <ConflictView note={note} />
      </>
    );
  }

  const ViewComponent = resolveNoteView(note, NoteEditor);
  return (
    <>
      <Link to="/" className="editor__back">← Notes</Link>
      <ViewComponent note={note} onSave={handleSave} />
    </>
  );
}
