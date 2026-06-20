import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, Link, useSearchParams, Navigate, useLocation } from 'react-router-dom';
import type { Note, NoteId, NotebookId } from '@deltos/shared';
import { NoteIdSchema } from '@deltos/shared';
import { getStore } from '../db/store.js';
import { noteHasContent } from '../lib/noteContent.js';
import { useNote, useNotebooks } from '../db/storeHooks.js';
import { mutateNotes } from '../db/mutate.js';
import { notifyQueueWrite } from '../lib/syncEngine.js';
import { getHistoryCapture } from '../lib/historyCapture.js';
import { useAuthStore } from '../auth/store.js';
import { NoteEditor } from '../editor/NoteEditor.js';
import { resolveNoteView } from '../editor/views.js';
import { ConflictView } from '../components/ConflictView.js';
import { HistoryPanel } from '../components/HistoryPanel.js';
import { useNoteVersions } from '../db/conflict.js';
import type { ClientNote, NotebookRow, NoteVersion } from '../db/schema.js';

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
  const { state } = useLocation();
  // True only when navigated from the new-note create flow — drives autoFocus on the editor.
  const isNew = (state as { isNew?: boolean } | null)?.isNew === true;
  // ConflictView is gated behind an explicit ?resolve param — never auto-triggered by sync.
  // Paths that set it: badge-tap (ConflictBadgeSlot) and back-with-conflict (← Notes below).
  const isResolving = searchParams.has('resolve');
  const [showMove, setShowMove] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const notebooks = useNotebooks();

  // B3 blank-note discard: track whether note was version=0+blank on first load.
  // Only newly-created notes (version=0, UNSYNCED) are candidates for discard;
  // existing synced notes emptied by the user are left as-is (pilot #32 scope).
  const noteWasNewAndBlankRef = useRef<boolean | null>(null);

  // Stable save handler: write to Dexie then kick Stream B's debounced sync.
  const handleSave = useCallback(async (note: Note) => {
    // History capture (#45): observe this already-debounced edit FIRST, synchronously — recordEdit's
    // snapshot update is sync, so the editor's final-flush-on-unmount is recorded BEFORE NoteRoute's
    // leave() runs in the same teardown (otherwise an await here would defer it past leave, losing the
    // last burst). Fire-and-forget + a separate noteVersions txn — never blocks or alters save/sync.
    const accountId = useAuthStore.getState().accountId;
    if (accountId) void getHistoryCapture().recordEdit(note.id, note);
    await mutateNotes.put(note);
    notifyQueueWrite(note.notebookId);
  }, []);

  // Must be above all early returns — hooks must be called in the same order every render.
  // targetId: null = move to All Notes (uncategorize); a real id = move to that notebook.
  const handleMove = useCallback(async (currentNote: Note, targetId: NotebookId | null) => {
    if (targetId === currentNote.notebookId) { setShowMove(false); return; }
    await mutateNotes.put({ ...currentNote, notebookId: targetId });
    notifyQueueWrite(targetId);
    setShowMove(false);
  }, []);

  const noteId = id ? NoteIdSchema.safeParse(id) : null;
  const parsedNoteId = noteId?.success ? noteId.data : null;

  // Reactive read through the store seam; undefined for an invalid id (guarded below) or while loading.
  const note = useNote(parsedNoteId ?? undefined);
  // Reactive version list — consumed by HistoryPanel; always scoped to the current account (conflict.ts).
  const versions = useNoteVersions(parsedNoteId ?? ('' as NoteId));

  const handleRestore = useCallback(async (version: NoteVersion) => {
    if (!note) return;
    const accountId = useAuthStore.getState().accountId;
    if (!accountId) return;
    // Capture the current note state as a history entry before overwriting, then restore.
    await getHistoryCapture().leave(note.id);
    const restored: Note = {
      ...note,
      title: version.title,
      body: version.body,
      properties: version.properties,
      updatedAt: new Date().toISOString(),
      syncStatus: 'pending',
      // Keep current `version` number for a CAS-safe push (same path as conflict keep-mine).
    };
    await mutateNotes.put(restored);
    notifyQueueWrite(note.notebookId);
    // Seed fresh capture baseline so the next session measures delta from the restored content.
    getHistoryCapture().open(note.id, accountId, restored);
    setShowHistory(false);
  }, [note]);

  // Capture new+blank state on first load — only version=0 notes are candidates.
  // Must be above early returns — rules-of-hooks.
  if (note !== undefined && noteWasNewAndBlankRef.current === null) {
    noteWasNewAndBlankRef.current = note.version === 0 && !noteHasContent(note);
  }

  // History capture (#45): open a capture session once the note is first loaded — its CURRENT content
  // is the pre-edit baseline the session's delta is measured against. Guarded so a reactive note change
  // (each save / a sync pull) never re-seeds the baseline. accountId scopes the version rows (client D6).
  const captureOpenedRef = useRef(false);
  useEffect(() => {
    if (captureOpenedRef.current || !parsedNoteId || note === undefined) return;
    const accountId = useAuthStore.getState().accountId;
    if (!accountId) return;
    captureOpenedRef.current = true;
    getHistoryCapture().open(parsedNoteId, accountId, note);
  }, [parsedNoteId, note]);

  // Leave (b): on unmount, flush the session — captures the final state if materially changed. Separate
  // effect keyed only to the note id so it fires exactly once when the route instance tears down.
  useEffect(() => {
    return () => {
      if (parsedNoteId) void getHistoryCapture().leave(parsedNoteId);
    };
  // parsedNoteId is stable for the lifetime of this route instance.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedNoteId]);

  // B3: discard newly-created blank notes on unmount (#32 scoped: version=0 only).
  // discardBlankNote is atomic (re-checks blank in IDB), so if the user typed content
  // the note won't be blank in IDB and the call is a safe no-op. Existing synced notes
  // cleared to blank are NOT discarded here — navSys deferred that path.
  useEffect(() => {
    return () => {
      if (!parsedNoteId || noteWasNewAndBlankRef.current !== true) return;
      void getStore().discardBlankNote(parsedNoteId);
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

  // History panel — full-screen overlay when requested.
  if (showHistory) {
    return (
      <HistoryPanel
        note={note}
        versions={versions}
        onBack={() => setShowHistory(false)}
        onRestore={handleRestore}
      />
    );
  }

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
            <li key="all-notes">
              <button
                className={`editor__move-nb${note.notebookId === null ? ' editor__move-nb--current' : ''}`}
                onClick={() => { void handleMove(note, null); }}
                disabled={note.notebookId === null}
              >
                All Notes
              </button>
            </li>
            {notebooks.map((nb) => (
              <li key={nb.id}>
                <button
                  className={`editor__move-nb${nb.id === note.notebookId ? ' editor__move-nb--current' : ''}`}
                  onClick={() => { void handleMove(note, nb.id); }}
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
      <button className="editor__history-btn" onClick={() => setShowHistory(true)}>History</button>
      <ViewComponent note={note} onSave={handleSave} autoFocus={isNew} />
    </>
  );
}
