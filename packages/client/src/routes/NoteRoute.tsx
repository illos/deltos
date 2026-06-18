import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, Link, useSearchParams, Navigate } from 'react-router-dom';
import type { Note, BlockBody } from '@deltos/shared';
import { NoteIdSchema } from '@deltos/shared';
import { getStore } from '../db/store.js';
import { useNote, useNotebooks } from '../db/storeHooks.js';
import { mutateNotes } from '../db/mutate.js';
import { notifyQueueWrite } from '../lib/syncEngine.js';
import { NoteEditor } from '../editor/NoteEditor.js';
import { resolveNoteView } from '../editor/views.js';
import { ConflictView } from '../components/ConflictView.js';
import type { ClientNote, NotebookRow } from '../db/schema.js';

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
  const [showMove, setShowMove] = useState(false);
  const notebooks = useNotebooks();

  // B3 blank-note discard: track the content at each save call so the unmount cleanup
  // can decide whether to keep or discard the note without a stale React-state read.
  const lastSavedRef = useRef<{ title: string; body: BlockBody } | null>(null);
  // Set once on first render where note is defined; used to detect pre-existing blank notes.
  const noteWasInitiallyBlankRef = useRef<boolean | null>(null);

  // Stable save handler: write to Dexie then kick Stream B's debounced sync.
  const handleSave = useCallback(async (note: Note) => {
    lastSavedRef.current = { title: note.title, body: note.body };
    await mutateNotes.put(note);
    notifyQueueWrite(note.notebookId);
  }, []);

  // Must be above all early returns — hooks must be called in the same order every render.
  const handleMove = useCallback(async (currentNote: Note, targetNotebook: NotebookRow) => {
    if (targetNotebook.id === currentNote.notebookId) { setShowMove(false); return; }
    await mutateNotes.put({ ...currentNote, notebookId: targetNotebook.id });
    notifyQueueWrite(targetNotebook.id);
    setShowMove(false);
  }, []);

  const noteId = id ? NoteIdSchema.safeParse(id) : null;
  const parsedNoteId = noteId?.success ? noteId.data : null;

  // Reactive read through the store seam; undefined for an invalid id (guarded below) or while loading.
  const note = useNote(parsedNoteId ?? undefined);

  // Capture blank state on first load (before any save on this visit).
  // Must be above early returns — rules-of-hooks.
  if (note !== undefined && noteWasInitiallyBlankRef.current === null) {
    noteWasInitiallyBlankRef.current = note.title === '' && note.body.length === 0;
  }

  // B3: discard truly blank notes on unmount. discardBlankNote is atomic (re-checks
  // in IDB), so a concurrent editor flush that writes content is handled correctly.
  // Known gap: if syncStatus='synced' the blank note may resurrect from server pull —
  // server-side delete is a follow-up; flagged to pilot (#30 report).
  useEffect(() => {
    return () => {
      if (!parsedNoteId) return;
      const lastSaved = lastSavedRef.current;
      const wasInitiallyBlank = noteWasInitiallyBlankRef.current;
      const isBlank =
        lastSaved !== null
          ? lastSaved.title === '' && lastSaved.body.length === 0
          : wasInitiallyBlank === true;
      if (isBlank) void getStore().discardBlankNote(parsedNoteId);
    };
  // parsedNoteId is stable for the lifetime of this route instance.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedNoteId]);

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
      return <Navigate to={`/note/${parsedNoteId}`} replace />;
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
        to={clientNote.hasConflict ? `/note/${parsedNoteId}?resolve` : '/'}
        className="editor__back"
      >
        ← Notes
      </Link>
      {showMove && (
        <div className="editor__move-picker" role="dialog" aria-label="Move note to notebook">
          <p className="editor__move-title">Move to notebook</p>
          <ul className="editor__move-list">
            {notebooks.map((nb) => (
              <li key={nb.id}>
                <button
                  className={`editor__move-nb${nb.id === note.notebookId ? ' editor__move-nb--current' : ''}`}
                  onClick={() => { void handleMove(note, nb); }}
                  disabled={nb.id === note.notebookId}
                >
                  {nb.name}
                </button>
              </li>
            ))}
          </ul>
          <button className="editor__move-cancel" onClick={() => setShowMove(false)}>Cancel</button>
        </div>
      )}
      <button className="editor__move-btn" onClick={() => setShowMove(true)}>Move to notebook…</button>
      <ViewComponent note={note} onSave={handleSave} />
    </>
  );
}
