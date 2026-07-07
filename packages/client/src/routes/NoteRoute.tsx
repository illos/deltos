import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { useParams, Link, useSearchParams, Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { Note, NoteId } from '@deltos/shared';
import { NoteIdSchema } from '@deltos/shared';
import { getStore } from '../db/store.js';
import { noteHasContent } from '../lib/noteContent.js';
import { useNote } from '../db/storeHooks.js';
import { mutateNotes } from '../db/mutate.js';
import { notifyQueueWrite } from '../lib/syncEngine.js';
import { getHistoryCapture } from '../lib/historyCapture.js';
import { useAuthStore } from '../auth/store.js';
import { NoteEditor } from '../editor/NoteEditor.js';
import { resolveNoteView } from '../editor/views.js';
import { ConflictView } from '../components/ConflictView.js';
import { HistoryPanel } from '../components/HistoryPanel.js';
import { InfoPanel } from '../components/InfoPanel.js';
import { NoteMetaBar } from '../components/NoteMetaBar.js';
import { useNoteVersions } from '../db/conflict.js';
import { Collapse } from '../icons/index.js';
import { useIsDesktop } from '../lib/useIsDesktop.js';
import { showActionToast } from '../lib/toastEvents.js';
import type { ClientNote, NoteVersion } from '../db/schema.js';

// SharesPanel (ROAD-0011 P2) is a LAZY off-track surface: its own chunk, imported only when the `?share`
// param is set, so neither the panel nor its shareApi client rides this route's static graph or the mobile
// first-load bundle (CONV-0004 / plugins-lazy-past-first-paint). Mirrors App.tsx's route-level lazy() usage.
const SharesPanel = lazy(() =>
  import('../components/SharesPanel.js').then((m) => ({ default: m.SharesPanel })),
);

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
export interface NoteRouteProps {
  /**
   * Chrome variant (ROAD-0010). 'regular' (default) is the note as it lives inside the 3-region /
   * mobile shell — its desktop meta toolbar carries the Full screen + Pop out ENTRY controls.
   * 'full' is the bare full-window view served at /note/:id/full: the SAME note composition with the
   * shell chrome stripped away; the entry controls are REPLACED by a single back-to-regular EXIT
   * control (no full-screen-inside-full-screen).
   */
  variant?: 'regular' | 'full';
}

export function NoteRoute({ variant = 'regular' }: NoteRouteProps = {}) {
  const isFull = variant === 'full';
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { state } = useLocation();
  // True only when navigated from the new-note create flow — drives autoFocus on the editor.
  const isNew = (state as { isNew?: boolean } | null)?.isNew === true;
  // ConflictView is gated behind an explicit ?resolve param — never auto-triggered by sync.
  // Paths that set it: badge-tap (ConflictBadgeSlot) and back-with-conflict (← Notes below).
  const isResolving = searchParams.has('resolve');
  const [showHistory, setShowHistory] = useState(false);
  // Per-note Info panel — parallel to showHistory. Desktop opens via the meta-bar ⓘ button (showInfo);
  // mobile opens via the shell bar's ⓘ (the ?info URL param, mirroring ?history).
  const [showInfo, setShowInfo] = useState(false);
  const navigate = useNavigate();
  // Desktop-only note-delete trashcan lives in the §3 meta row (mobile keeps swipe-to-delete).
  const isDesktop = useIsDesktop();

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

  // Desktop note-delete: reuses the exact soft-delete→Trash path the mobile SwipeRow uses
  // (recoverable, sticky, identical behavior) + the same Undo toast, then returns region 3 to
  // the list/empty state. Note delete only — separate from the parked notebook-delete affordance.
  const handleDeleteNote = useCallback(() => {
    if (!note) return;
    mutateNotes.softDelete(note).catch(console.error);
    showActionToast(`"${note.title || 'Untitled'}" deleted`, {
      label: 'Undo',
      fn: () => { mutateNotes.restore(note).catch(console.error); },
    });
    navigate('/');
  }, [note, navigate]);

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

  // History panel — full-screen overlay when requested. Opened by the desktop editor__meta button
  // (showHistory) OR, on mobile (#82), the global shell bar's History button via the ?history URL param.
  if (showHistory || searchParams.has('history')) {
    return (
      <HistoryPanel
        note={note}
        versions={versions}
        onBack={() => {
          setShowHistory(false);
          if (searchParams.has('history')) {
            const next = new URLSearchParams(searchParams);
            next.delete('history');
            setSearchParams(next, { replace: true });
          }
        }}
        onRestore={handleRestore}
      />
    );
  }

  // Info panel — full-screen overlay, parallel to History. Opened by the desktop meta-bar ⓘ (showInfo)
  // OR, on mobile, the global shell bar's Info button via the ?info URL param.
  if (showInfo || searchParams.has('info')) {
    return (
      <InfoPanel
        note={note}
        onSave={handleSave}
        onBack={() => {
          setShowInfo(false);
          if (searchParams.has('info')) {
            const next = new URLSearchParams(searchParams);
            next.delete('info');
            setSearchParams(next, { replace: true });
          }
        }}
      />
    );
  }

  // Share panel — full-screen overlay, parallel to History/Info. Opened by the note action surface's Share
  // button via the ?share URL param (mobile shell bar + desktop meta bar both navigate here). Lazy chunk —
  // dynamic-imported above so it never touches the first-load shell.
  if (searchParams.has('share')) {
    return (
      <Suspense fallback={<div className="history share" aria-busy="true" />}>
        <SharesPanel
          note={note}
          onBack={() => {
            const next = new URLSearchParams(searchParams);
            next.delete('share');
            setSearchParams(next, { replace: true });
          }}
        />
      </Suspense>
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
      {/* §3 note meta toolbar — DESKTOP ONLY (#82): the desktop 3-region note pane has no global shell bar,
          so it carries Synced + version-history + delete + the full-window controls here. On MOBILE the
          global shell__bar is the single note bar (history lives there via ?history), so this is omitted
          entirely — no second bar, no back chevron (the δ wordmark → '/' covers return).
          File notes now get the SAME bar above FileNoteView (Jim): history / full-screen / pop-out / delete.
          FileNoteView keeps its own download/rename/delete actions row; the delete here and there are the
          identical soft-delete → Trash path. File notes have no version capture, so History opens to a sane
          empty state ("No earlier versions"), never a crash. */}
      {isDesktop && (
        <NoteMetaBar
          noteId={note.id}
          isFull={isFull}
          onShowHistory={() => setShowHistory(true)}
          onShowInfo={() => setShowInfo(true)}
          onDelete={handleDeleteNote}
        />
      )}
      {/* ROAD-0010 full-window fallback exit — the desktop meta toolbar now renders for EVERY note (incl. file
          notes), so it carries the exit in desktop full mode. This fallback only covers a MOBILE visit to
          /note/:id/full (no meta toolbar there), guaranteeing ONE unobtrusive way back to the 3-region view. */}
      {isFull && !isDesktop && (
        <Link to={`/note/${parsedNoteId}`} className="editor__full-exit" aria-label="Exit full screen">
          <Collapse size={20} />
        </Link>
      )}
      <ViewComponent note={note} onSave={handleSave} autoFocus={isNew} />
    </>
  );
}
