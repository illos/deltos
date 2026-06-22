import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate, useMatch } from 'react-router-dom';
import type { Note } from '@deltos/shared';
import type { NotebookId } from '@deltos/shared';
import { NewNote } from './routes/NewNote.js';
import { NoteRoute } from './routes/NoteRoute.js';
import { RegisterRoute } from './routes/RegisterRoute.js';
import { LoginRoute } from './routes/LoginRoute.js';
import { ResetRoute } from './routes/ResetRoute.js';
import { ForcedPhraseRoute } from './routes/ForcedPhraseRoute.js';
import { TrashRoute } from './routes/TrashRoute.js';
import { SearchRoute } from './routes/SearchRoute.js';
import { KbProbe } from './routes/KbProbe.js';
const SettingsRoute = lazy(() =>
  import('./routes/SettingsRoute.js').then((m) => ({ default: m.SettingsRoute })),
);
import { DrawerNav } from './components/DrawerNav.js';
import { BottomNav } from './components/BottomNav.js';
import { ThreeRegionShell } from './components/ThreeRegionShell.js';
import { useIsDesktop } from './lib/useIsDesktop.js';
import { startSyncTriggers, syncNow } from './lib/syncEngine.js';
import { resolveCollectionView } from './lib/collectionViews.js';
import type { CollectionViewProps } from './lib/collectionViews.js';
import { useNotebookStore } from './lib/notebookStore.js';
import { notePreview, formatSmartDate } from './lib/notePreview.js';
import { ComposeNew, Search } from './icons/index.js';
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
  // #68 throwaway probe: an isolated, AUTH-BYPASSED test route so Jim can hit /kbprobe directly on the
  // live site (no login friction) to feel-test inputmode=none. Hook called unconditionally above.
  const kbProbe = useMatch('/kbprobe');
  if (kbProbe) return <KbProbe />;

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
 * priority. Filters the account-wide note store by notebookId so switching notebooks changes
 * the list. useNotes() stays account-wide (NavContent needs cross-notebook counts).
 */
export function HomeView({ notebookId }: CollectionViewProps) {
  const allNotes = useNotes();
  // null = All Notes = show every non-trashed note; a real id = filter to that notebook's notes.
  const notes = notebookId === null ? allNotes : allNotes.filter((n) => n.notebookId === notebookId);
  // List header name: the current notebook, or "All Notes" for the null aggregate (#59).
  const notebook = useCurrentNotebook();
  const listName = notebookId === null ? 'All Notes' : (notebook?.name ?? '…');
  // Selected-row (master-detail): the note open in the right region, from the URL — works even though
  // HomeView renders OUTSIDE the note Route (useMatch reads the current location anywhere).
  const noteMatch = useMatch('/note/:id');
  const openNoteId = noteMatch?.params.id ?? null;
  const navigate = useNavigate();
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
      {/* §2 list header: notebook name + N-notes count (top-left), compose icon top-right (off the FAB). */}
      <header className="home__header">
        <div className="home__heading">
          <h1 className="home__title">{listName}</h1>
          <span className="dt-meta--faint home__count">{notes.length} {notes.length === 1 ? 'note' : 'notes'}</span>
        </div>
        <Link to="/new" className="home__compose" aria-label="New note">
          <ComposeNew size={21} />
        </Link>
      </header>

      {/* §2 persistent search field. Static-vibe: a real field-look that opens the search view (region 3). */}
      <div className="home__search">
        <button className="home__search-field" onClick={() => navigate('/search')}>
          <Search className="home__search-icon" size={15} />
          <span className="home__search-placeholder">Search</span>
        </button>
      </div>

      {notes.length === 0 ? (
        <p className="home__lede">No notes yet.</p>
      ) : (
        <ul className="home__notes">
          {notes.map(note => {
            const { displayTitle, previewLine } = notePreview(note);
            const smartDate = formatSmartDate(note.updatedAt);
            const selected = note.id === openNoteId;
            return (
              <li key={note.id}>
                <SwipeRow
                  isOpen={openId === note.id}
                  onOpen={() => setOpenId(note.id)}
                  onClose={() => setOpenId(null)}
                  onDelete={() => handleDelete(note)}
                  onDuplicate={() => handleDuplicate(note)}
                >
                  <Link
                    to={`/note/${note.id}`}
                    className={`home__note-link${selected ? ' home__note-link--selected' : ''}`}
                    aria-current={selected ? 'page' : undefined}
                  >
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
    </div>
  );
}

// Sentinel used as the sync deduplication key on a fresh device before the default
// notebook arrives via the first pull. The actual account scope comes from the bearer token.
const INITIAL_SYNC_SENTINEL = '00000000-0000-4000-8000-000000000000' as NotebookId;

function AuthedShell() {
  const sessionState = useAuthStore((s) => s.sessionState);
  const _ready = useNotebookStore((s) => s._ready);
  const currentNotebookId = useNotebookStore((s) => s.currentNotebookId);
  const initNotebook = useNotebookStore((s) => s.init);
  const notebook = useCurrentNotebook();
  const notebookName = currentNotebookId === null ? 'All Notes' : (notebook?.name ?? '…');
  // navOpen / DrawerNav is desktop-only (mobile uses BottomNav via CSS)
  const [navOpen, setNavOpen] = useState(false);
  const navigate = useNavigate();
  // Device class drives the structural fork: desktop = persistent 3-region master-detail; mobile =
  // single-column push + bottom-sheet nav. Called before the early returns (rules-of-hooks).
  const isDesktop = useIsDesktop();

  // Load the device-local current notebook from IDB on first mount (with localStorage migration).
  useEffect(() => { void initNotebook(); }, [initNotebook]);

  // Start sync triggers as soon as the notebook pointer IDB read is done — even on a fresh
  // device with no current notebook. Sync is account-scoped (bearer token); notebookId is
  // only a push hint. The first pull delivers notebooks → mergeNotebooks auto-selects the
  // default → currentNotebookId goes from null → real ID → effect restarts with the real key.
  const syncKey = currentNotebookId ?? INITIAL_SYNC_SENTINEL;
  useEffect(() => {
    if (!_ready) return;
    return startSyncTriggers(syncKey);
  }, [_ready, syncKey]);

  // When the background session goes live, drain the queue immediately.
  // syncNow is single-flight-guarded so concurrent triggers collapse to one push.
  useEffect(() => {
    if (sessionState === 'active') syncNow(syncKey);
  }, [sessionState, syncKey]);

  // Notebook state is loading — brief IDB read (< 10ms on device).
  if (!_ready) {
    return (
      <div className="auth">
        <div className="auth__spinner" aria-label="Loading" />
      </div>
    );
  }

  // null = All Notes (default); a real id = a specific notebook. Both are valid; render the shell.
  const notebookId: NotebookId | null = currentNotebookId;
  const CollectionView = resolveCollectionView(notebookId, HomeView);

  // DESKTOP / tablet-landscape: the persistent 3-region shell (nav pane | resizable list | note
  // master-detail). All routes render in the note region (Jim's decision (a)); nav + list stay
  // mounted. No top bar / drawer / FAB / bottom-nav here — each region carries its own chrome.
  if (isDesktop) {
    return (
      <>
        <ThreeRegionShell notebookId={notebookId} CollectionView={CollectionView} />
        <ConflictToastHostSlot />
      </>
    );
  }

  // MOBILE / tablet-portrait: single-column, route-driven (note pushes over the list) + bottom-sheet nav.
  return (
    <div className="shell">
      {/* Desktop: left-drawer nav (hidden on mobile via CSS). Mobile: BottomNav below. */}
      <DrawerNav open={navOpen} onClose={() => setNavOpen(false)} />

      <header className="shell__bar">
        {/*
          Desktop: the notebook name is a trigger for the drawer.
          Mobile (via CSS .shell__nb-trigger--mobile-readonly): just a context label —
          the BottomNav handles all navigation so this button is inert on mobile.
        */}
        <button
          className="shell__nb-trigger shell__nb-trigger--desktop-only"
          onClick={() => setNavOpen(true)}
          aria-label={`Open notebook switcher (${notebookName})`}
          aria-expanded={navOpen}
        >
          <span className="shell__nb-name">{notebookName}</span>
          <span className="shell__nb-chevron"> ▾</span>
        </button>
        {/* Mobile-only context label (no trigger): displayed instead of the button above */}
        <span className="shell__nb-label shell__nb-label--mobile-only">
          {notebookName}
        </span>
        <Link to="/" className="shell__mark">δ deltos</Link>
        <div className="shell__bar-end">
          {/* Desktop search button — hidden on mobile (BottomNav has the Search slot). */}
          <button className="shell__search-btn shell__search-btn--desktop-only" aria-label="Search" onClick={() => navigate('/search')}>🔍</button>
          <SessionStatus />
          <SyncIndicator />
        </div>
      </header>

      <main className="shell__main">
        <Routes>
          <Route path="/new" element={<NewNote />} />
          <Route path="/note/:id" element={<NoteRoute />} />
          <Route path="/trash" element={<TrashRoute />} />
          <Route path="/search" element={<SearchRoute />} />
          <Route
            path="/settings"
            element={
              <Suspense fallback={<div className="auth"><div className="auth__spinner" aria-label="Loading" /></div>}>
                <SettingsRoute />
              </Suspense>
            }
          />
          <Route path="/" element={<CollectionView notebookId={notebookId} />} />
          {/* Auth routes are the gate — redirect home in the shell (session re-established by init on reload). */}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/register" element={<Navigate to="/" replace />} />
          <Route path="/reset" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {/* FAB — desktop only; mobile uses BottomNav "New note" slot. */}
      <Link to="/new" className="shell__fab shell__fab--desktop-only" aria-label="New note">＋</Link>

      {/* Bottom nav bar — mobile + tablet-portrait only (CSS-gated). */}
      <BottomNav />

      {/* TOAST-HOST MOUNT SLOT — gruntSys2 fills this with the conflict ToastHost for Part 2.
          Leave the slot; do not build the toast here. */}
      <ConflictToastHostSlot />
    </div>
  );
}
