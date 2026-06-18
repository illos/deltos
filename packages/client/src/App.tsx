import { useEffect, useState, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import type { Note } from '@deltos/shared';
import type { NotebookId } from '@deltos/shared';
import { NewNote } from './routes/NewNote.js';
import { NoteRoute } from './routes/NoteRoute.js';
import { RegisterRoute } from './routes/RegisterRoute.js';
import { LoginRoute } from './routes/LoginRoute.js';
import { ResetRoute } from './routes/ResetRoute.js';
import { ForcedPhraseRoute } from './routes/ForcedPhraseRoute.js';
import { TrashRoute } from './routes/TrashRoute.js';
import { AllNotebooksScreen } from './views/AllNotebooksScreen.js';
import { startSyncTriggers, syncNow } from './lib/syncEngine.js';
import { resolveCollectionView } from './lib/collectionViews.js';
import type { CollectionViewProps } from './lib/collectionViews.js';
import { useNotebookStore } from './lib/notebookStore.js';
import { notePreview, formatSmartDate } from './lib/notePreview.js';
import { SyncIndicator } from './components/SyncIndicator.js';
import { SessionStatus } from './components/SessionStatus.js';
import { ConflictToastHostSlot } from './components/ConflictToastHostSlot.js';
import { ConflictBadgeSlot } from './components/ConflictBadgeSlot.js';
import { SwipeRow } from './components/SwipeRow.js';
import { useAuthStore } from './auth/store.js';
import { selectBootView } from './auth/shellGate.js';
import { useNotes, useCurrentNotebook } from './db/storeHooks.js';
import { mutateNotes } from './db/mutate.js';
import { showToast, showActionToast } from './lib/toastEvents.js';

/**
 * App shell — the local-first host chrome that every surface mounts inside.
 *
 * UNGATED DAY-TO-DAY. The notes shell renders as soon as a durable session is confirmed:
 *   - `init()` rides POST /api/auth/refresh (the httpOnly cookie auto-attaches) → re-mints an
 *     in-memory access token. If the cookie is valid → shell, no prompt. If not → auth gate.
 *   - The boot view is chosen by {@link selectBootView}(isAuthed, isAuthing): durable session live
 *     → the notes shell; no session → the register/login/reset gate. The `isAuthing` latch pins
 *     the auth surface through a live ceremony so the gate can't short-circuit it (P0 anti-unmount).
 *   - A failed/expired background session is a quiet, non-blocking nudge ({@link SessionStatus}),
 *     never a forced eviction — sync retries on reconnect.
 *
 * Routing uses BrowserRouter (history API). The service worker's SPA navigation fallback serves
 * index.html for all in-scope navigations, so direct loads of /note/:id work offline.
 */
export function App() {
  const init = useAuthStore((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

function AppRoutes() {
  const isAuthed = useAuthStore((s) => s.isAuthed);
  // A live auth ceremony (register/login/reset) pins the gate to the auth surface so the shell
  // can't short-circuit a ceremony before it fully completes (P0 anti-unmount latch).
  const isAuthing = useAuthStore((s) => s.isAuthing);
  // P0-belt: an explicit server false forces the phrase screen before shell entry (abandoned-signup).
  const recoveryEstablished = useAuthStore((s) => s.recoveryEstablished);

  switch (selectBootView(isAuthed, isAuthing, recoveryEstablished)) {
    // Cold-boot /refresh still in flight — a brief neutral hold before the gate decision resolves.
    case 'boot':
      return (
        <div className="auth">
          <div className="auth__spinner" aria-label="Loading" />
        </div>
      );

    // No durable session (and no live ceremony) → the register / login / reset gate.
    // /forced-phrase is in this block so LoginRoute can navigate there when recoveryRequired=true
    // while isAuthing=true keeps the gate pinned (ForcedPhraseRoute finalizes to open the shell).
    case 'auth-gate':
      return (
        <Routes>
          <Route path="/register" element={<RegisterRoute />} />
          <Route path="/login" element={<LoginRoute />} />
          <Route path="/reset" element={<ResetRoute />} />
          <Route path="/forced-phrase" element={<ForcedPhraseRoute />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      );

    // Cold-boot recovery-gate: session is live but recoveryEstablished=false (abandoned-signup belt).
    // Render the forced-phrase screen directly (no route needed — isAuthed=true, not in auth-gate).
    case 'recovery-gate':
      return <ForcedPhraseRoute />;

    // Durable session live + recovery established → render notes immediately, ungated.
    case 'shell':
      return <AuthedShell />;
  }
}

/**
 * The v1 standard-list collection view. Registered as the fallback for `resolveCollectionView`;
 * future views (kanban, board, etc.) register with a specific `matches` predicate and take
 * priority. In v1 the notebookId prop is accepted but not used — notes are account-scoped.
 */
function HomeView({ notebookId: _notebookId }: CollectionViewProps) {
  const notes = useNotes();
  // Single-open invariant: only one swipe row open at a time
  const [openId, setOpenId] = useState<string | null>(null);

  const handleDelete = useCallback((note: Note) => {
    mutateNotes.softDelete(note).catch(console.error);
    showActionToast(`"${note.title || 'Untitled'}" deleted`, {
      label: 'Undo',
      fn: () => { mutateNotes.restore(note).catch(console.error); },
    });
  }, []);

  const handleDuplicate = useCallback((note: Note) => {
    mutateNotes.duplicate(note).then(() => showToast('Duplicated')).catch(console.error);
  }, []);

  return (
    <div className="home">
      <div className="home__header">
        <span className="home__title">Notes</span>
        <Link to="/new" className="home__new-btn">+ New</Link>
      </div>
      {notes.length === 0 ? (
        <p className="home__lede">No notes yet.</p>
      ) : (
        <ul className="home__notes">
          {notes.map(note => {
            const { displayTitle, previewLine } = notePreview(note);
            const smartDate = formatSmartDate(note.updatedAt);
            return (
              <li key={note.id}>
                <SwipeRow
                  isOpen={openId === note.id}
                  onOpen={() => setOpenId(note.id)}
                  onClose={() => setOpenId(null)}
                  onDelete={() => handleDelete(note)}
                  onDuplicate={() => handleDuplicate(note)}
                >
                  <Link to={`/note/${note.id}`} className="home__note-link">
                    <span className="home__note-title">{displayTitle}</span>
                    <span className="home__note-meta">
                      <span className="home__note-date">{smartDate}</span>
                      {previewLine && <span className="home__note-preview">{previewLine}</span>}
                    </span>
                  </Link>
                  <ConflictBadgeSlot note={note} />
                </SwipeRow>
              </li>
            );
          })}
        </ul>
      )}

      <div className="home__footer">
        <Link to="/trash" className="home__trash-link">Trash</Link>
      </div>
    </div>
  );
}

function AuthedShell() {
  const sessionState = useAuthStore((s) => s.sessionState);
  const _ready = useNotebookStore((s) => s._ready);
  const currentNotebookId = useNotebookStore((s) => s.currentNotebookId);
  const initNotebook = useNotebookStore((s) => s.init);
  const notebook = useCurrentNotebook();
  const notebookName = notebook?.name ?? '…';

  // Load the device-local current notebook from IDB on first mount (with localStorage migration).
  useEffect(() => { void initNotebook(); }, [initNotebook]);

  // Start sync triggers only after the notebook ID is known. Restarts on notebook switch.
  useEffect(() => {
    if (!currentNotebookId) return;
    return startSyncTriggers(currentNotebookId);
  }, [currentNotebookId]);

  // When the background session goes live (e.g. after a gesture-unlock from the nudge), drain the
  // queue immediately rather than waiting for the 2s poll. syncNow is single-flight-guarded, so the
  // StrictMode double-invoke and concurrent triggers collapse to one push.
  useEffect(() => {
    if (sessionState === 'active' && currentNotebookId) syncNow(currentNotebookId);
  }, [sessionState, currentNotebookId]);

  // Notebook state is loading — brief IDB read (< 10ms on device).
  if (!_ready) {
    return (
      <div className="auth">
        <div className="auth__spinner" aria-label="Loading" />
      </div>
    );
  }

  // No notebook set (new device, or dangling pointer) → notebook picker.
  if (!currentNotebookId) return <AllNotebooksScreen />;

  // Notebook ready: resolve the collection view for this notebook (v1 always returns HomeView).
  const notebookId: NotebookId = currentNotebookId;
  const CollectionView = resolveCollectionView(notebookId, HomeView);

  return (
    <div className="shell">
      <header className="shell__bar">
        {/* TODO #21: wire onClick to open the left nav drawer */}
        <button className="shell__nb-trigger" onClick={() => {/* drawer — #21 */}} aria-label={`Switch notebook (${notebookName})`}>
          <span className="shell__nb-name">{notebookName}</span>
          <span className="shell__nb-chevron"> ▾</span>
        </button>
        <Link to="/" className="shell__mark">δ deltos</Link>
        <div className="shell__bar-end">
          {/* TODO #21: wire search affordance */}
          <button className="shell__search-btn" aria-label="Search" onClick={() => {/* search — later */}}>🔍</button>
          <SessionStatus />
          <SyncIndicator />
        </div>
      </header>

      <main className="shell__main">
        <Routes>
          <Route path="/new" element={<NewNote />} />
          <Route path="/note/:id" element={<NoteRoute />} />
          <Route path="/trash" element={<TrashRoute />} />
          <Route path="/" element={<CollectionView notebookId={notebookId} />} />
          {/* Auth routes are the gate — redirect home in the shell (session re-established by init on reload). */}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/register" element={<Navigate to="/" replace />} />
          <Route path="/reset" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <Link to="/new" className="shell__fab" aria-label="New note">＋</Link>

      {/* TOAST-HOST MOUNT SLOT — gruntSys2 fills this with the conflict ToastHost for Part 2.
          Leave the slot; do not build the toast here. */}
      <ConflictToastHostSlot />
    </div>
  );
}
