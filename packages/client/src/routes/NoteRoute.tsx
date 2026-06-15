import { useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { NoteIdSchema } from '@deltos/shared';
import { db } from '../db/schema.js';
import { mutateNotes } from '../db/mutate.js';
import { NoteEditor } from '../editor/NoteEditor.js';
import { resolveNoteView } from '../editor/views.js';

/**
 * Loads a note by ID from the local Dexie store and renders the appropriate view.
 *
 * useLiveQuery is reactive: when Stream B's sync engine writes an incoming server update to
 * db.notes, this component re-renders automatically — without polling or manual refresh.
 *
 * View resolution: note → resolveNoteView(note) → render. Phase 1 always resolves to the
 * block editor (NoteEditor / ProseMirror). Phase 2 can register full-view descriptors for
 * notebook-capability-specific rendering without changing this route (see editor/views.ts).
 */
export function NoteRoute() {
  const { id } = useParams<{ id: string }>();

  const noteId = id ? NoteIdSchema.safeParse(id) : null;

  // async querier keeps the return type as Promise<T>, avoiding PromiseExtended inference issues.
  const note = useLiveQuery(
    async () => {
      if (!noteId?.success) return undefined;
      return db.notes.get(noteId.data);
    },
    [noteId?.success ? noteId.data : null],
  );

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

  const ViewComponent = resolveNoteView(note, NoteEditor);
  return <ViewComponent note={note} onSave={mutateNotes.put} />;
}
