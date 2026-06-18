import { useCallback } from 'react';
import { useParams, Link, useSearchParams, Navigate } from 'react-router-dom';
import type { Note } from '@deltos/shared';
import { NoteIdSchema } from '@deltos/shared';
import { useNote } from '../db/storeHooks.js';
import { mutateNotes } from '../db/mutate.js';
import { notifyQueueWrite } from '../lib/syncEngine.js';
import { getDefaultNotebookId } from '../lib/notebooks.js';
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
  const [searchParams] = useSearchParams();
  // ConflictView is gated behind an explicit ?resolve param — never auto-triggered by sync.
  // Paths that set it: badge-tap (ConflictBadgeSlot) and back-with-conflict (← Notes below).
  const isResolving = searchParams.has('resolve');

  // Stable save handler: write to Dexie then kick Stream B's debounced sync.
  const handleSave = useCallback(async (note: Note) => {
    await mutateNotes.put(note);
    notifyQueueWrite(getDefaultNotebookId());
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

  // Conflict resolution view — only when explicitly requested via ?resolve.
  if (isResolving) {
    // Conflict was just resolved (hasConflict cleared): drop ?resolve and show the editor.
    if (!clientNote.hasConflict) {
      return <Navigate to={`/note/${noteId.data}`} replace />;
    }
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
      {/* Exit-with-conflict: if the note has an unresolved conflict, the back link
          first routes through ?resolve so the user can resolve before leaving. */}
      <Link
        to={clientNote.hasConflict ? `/note/${noteId.data}?resolve` : '/'}
        className="editor__back"
      >
        ← Notes
      </Link>
      <ViewComponent note={note} onSave={handleSave} />
    </>
  );
}
