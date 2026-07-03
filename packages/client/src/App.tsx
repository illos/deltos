import { useEffect, useState, useCallback, useMemo, lazy, Suspense } from 'react';
import type { DragEvent } from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate, useMatch, useLocation } from 'react-router-dom';
import type { Note } from '@deltos/shared';
import { isFileNote } from '@deltos/shared';
import type { NotebookId } from '@deltos/shared';
import { NewNote } from './routes/NewNote.js';
import { RegisterRoute } from './routes/RegisterRoute.js';
import { LoginRoute } from './routes/LoginRoute.js';
import { ResetRoute } from './routes/ResetRoute.js';
import { ForcedPhraseRoute } from './routes/ForcedPhraseRoute.js';
import { TrashRoute } from './routes/TrashRoute.js';
import { SearchRoute } from './routes/SearchRoute.js';
// LAZY: the note editor (ProseMirror + ALL its plugins: formula/math/hexcolor, embeds, voice, spellcheck
// wiring) is the heaviest subtree — split it out of the entry bundle so the shell paints first; it loads
// on note-open (precached after the first load → instant warm). Settings likewise.
const NoteRoute = lazy(() => import('./routes/NoteRoute.js').then((m) => ({ default: m.NoteRoute })));
const SettingsRoute = lazy(() =>
  import('./routes/SettingsRoute.js').then((m) => ({ default: m.SettingsRoute })),
);
// NOTE: OAuth consent is NO LONGER a route in this app. It is a SEPARATE standalone surface served at
// /oauth/* (oauth-consent-surface-separation.md / DEC-0005), decoupled from this router / shell / service
// worker. The notes SW passes /oauth/ navigations through to the network (sw.ts denylist).
import { DrawerNav } from './components/DrawerNav.js';
import { FullScreenNav } from './components/FullScreenNav.js';
import { BottomNav } from './components/BottomNav.js';
import { ThreeRegionShell } from './components/ThreeRegionShell.js';
import { DeckHostProvider } from './components/DeckHost.js';
import { useIsDesktop } from './lib/useIsDesktop.js';
import { useTouchPrimary } from './lib/useTouchPrimary.js';
import { useNoteDnd } from './lib/dnd/useNoteDnd.js';
import { useFileNoteDnd } from './lib/dnd/useFileNoteDnd.js';
import { useKeypadMode } from './lib/useKeypadMode.js';
import { startSyncTriggers, syncNow } from './lib/syncEngine.js';
import { resolveCollectionView } from './lib/collectionViews.js';
import type { CollectionViewProps } from './lib/collectionViews.js';
import { useNotebookStore } from './lib/notebookStore.js';
import { notePreview, formatSmartDate } from './lib/notePreview.js';
import { ComposeNew, Search, Ellipsis, VersionHistory } from './icons/index.js';
import { SyncIndicator } from './components/SyncIndicator.js';
import { SessionStatus } from './components/SessionStatus.js';
import { ConflictToastHostSlot } from './components/ConflictToastHostSlot.js';
import { UploadProgressHost } from './components/UploadProgressHost.js';
import { ConflictBadgeSlot } from './components/ConflictBadgeSlot.js';
import { SwipeRow } from './components/SwipeRow.js';
import { FileNotePill } from './components/FileNotePill.js';
// Side-effect: register the FileNoteView against resolveNoteView so a file note opens in the viewer (not the
// PM editor). Tiny module — the viewer itself is a lazy chunk (gate FN-8); see views/registerFileNoteView.ts.
import './views/registerFileNoteView.js';
import { NotebookPickerSheet } from './components/NotebookPickerSheet.js';
import { useAuthStore } from './auth/store.js';
import { selectBootView } from './auth/shellGate.js';
import { useNotes, useCurrentNotebook, useNotebooks } from './db/storeHooks.js';
import { mutateNotes } from './db/mutate.js';
import { notifyQueueWrite } from './lib/syncEngine.js';
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
    // #85 reconnect upgrade: after an OFFLINE shell boot (sessionState 'offline', no bearer), silently
    // re-run init when connectivity returns → re-mints the access token + flips sessionState back to
    // 'active', so sync resumes with NO re-login. Gated on 'offline' so a normal online session never
    // re-refreshes spuriously.
    const reInitIfOffline = () => {
      if (useAuthStore.getState().sessionState === 'offline') void init();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') reInitIfOffline(); };
    window.addEventListener('online', reInitIfOffline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', reInitIfOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
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
  // #75: in the All-Notes aggregate, each categorized row shows its notebook-name pill. id→name map for the
  // lookup (only consulted in the notebookId===null branch). A note whose id isn't here (shouldn't happen)
  // simply gets no pill (treated as uncategorized).
  const notebooks = useNotebooks();
  const notebookNameById = useMemo(() => {
    const m = new Map<NotebookId, string>();
    for (const nb of notebooks) m.set(nb.id, nb.name);
    return m;
  }, [notebooks]);
  // Selected-row (master-detail): the note open in the right region, from the URL — works even though
  // HomeView renders OUTSIDE the note Route (useMatch reads the current location anywhere).
  const noteMatch = useMatch('/note/:id');
  const openNoteId = noteMatch?.params.id ?? null;
  const navigate = useNavigate();
  // Single-open invariant: only one swipe row open at a time
  const [openId, setOpenId] = useState<string | null>(null);
  // #78 swipe-to-move: the note whose notebook-picker sheet is open (null = closed).
  const [movingNote, setMovingNote] = useState<Note | null>(null);
  // #79 desktop note→notebook drag-and-drop: lazily-loaded chunk, desktop only (null on mobile / until loaded).
  const isDesktop = useIsDesktop();
  const noteDnd = useNoteDnd(isDesktop);
  // file-notes §5.1 desktop list-drop → file-note creation: a second lazy desktop-only chunk (mirror of
  // noteDnd). Drop OS files on the list pane → one file note per file; stays on the list (reactive pill).
  const fileNoteDnd = useFileNoteDnd(isDesktop);
  const [fileDragOver, setFileDragOver] = useState(false);
  const fileDropProps = fileNoteDnd
    ? {
        onDragOver: (e: DragEvent) => { if (fileNoteDnd.allowFileDrop(e)) setFileDragOver(true); },
        onDragLeave: (e: DragEvent) => {
          // Ignore the dragleave fired when crossing into a child element (relatedTarget still inside).
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileDragOver(false);
        },
        onDrop: (e: DragEvent) => { setFileDragOver(false); void fileNoteDnd.dropFilesOnList(e); },
      }
    : {};

  const handleMove = useCallback((note: Note, targetNotebookId: NotebookId | null) => {
    setMovingNote(null);
    if (targetNotebookId === note.notebookId) return; // no-op (also disabled in the sheet)
    void mutateNotes.put({ ...note, notebookId: targetNotebookId })
      .then(() => notifyQueueWrite(targetNotebookId))
      .catch(console.error);
    showToast('Moved');
  }, []);

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
    <div className={`home${fileDragOver ? ' home--file-drag' : ''}`} {...fileDropProps}>
      {/* file-notes §5.1 desktop list-drop affordance — a panel-spanning drop surface shown while an OS file
          is dragged over the list pane. Absolutely positioned (inset:0) inside .home, which is an isolated
          stacking context filling the FULL list panel (min-height:100% in the 3-region list); z-index:1 lifts
          it ABOVE the note rows (positioned SwipeRows) so it reads as a deliberate "drop here" surface the
          rows don't show through — and stays confined to this pane. pointer-events:none so it never
          intercepts the drag/drop on .home. */}
      {fileDragOver && (
        <div className="home__drop-overlay" aria-hidden="true">
          <span className="home__drop-label">Drop to add a file</span>
        </div>
      )}
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
            const isFile = isFileNote(note);
            // Notebook pill: ONLY in the All-Notes aggregate, ONLY for a categorized note whose notebook is
            // known. Uncategorized (notebookId null) or a specific-notebook view → no pill.
            const nbName = notebookId === null && note.notebookId !== null
              ? notebookNameById.get(note.notebookId)
              : undefined;
            return (
              <li key={note.id}>
                <SwipeRow
                  isOpen={openId === note.id}
                  onOpen={() => setOpenId(note.id)}
                  onClose={() => setOpenId(null)}
                  onDelete={() => handleDelete(note)}
                  onDuplicate={() => handleDuplicate(note)}
                  onMove={() => setMovingNote(note)}
                >
                  <Link
                    to={`/note/${note.id}`}
                    className={`home__note-link${selected ? ' home__note-link--selected' : ''}${isFile ? ' home__note-link--file' : ''}`}
                    aria-current={selected ? 'page' : undefined}
                    draggable={noteDnd ? true : undefined}
                    onDragStart={noteDnd ? (e) => noteDnd.startNoteDrag(e, note) : undefined}
                    onDragEnd={noteDnd ? () => noteDnd.endNoteDrag() : undefined}
                  >
                    {isFile ? (
                      // file-notes §3.1: a file note renders as an artifact pill (leading visual + filename +
                      // size/type), not the prose title + preview row.
                      <FileNotePill note={note} />
                    ) : (
                      <>
                        <span className="home__note-title">{displayTitle}</span>
                        <span className="home__note-meta">
                          <span className="home__note-date">{smartDate}</span>
                          {previewLine && <span className="home__note-preview">{previewLine}</span>}
                          {nbName && <span className="home__note-nb-pill">{nbName}</span>}
                        </span>
                      </>
                    )}
                  </Link>
                  <ConflictBadgeSlot note={note} />
                </SwipeRow>
              </li>
            );
          })}
        </ul>
      )}
      {/* #78 swipe-to-move → notebook-picker bottom sheet (mobile). */}
      {movingNote && (
        <NotebookPickerSheet
          notebooks={notebooks}
          currentNotebookId={movingNote.notebookId}
          onSelect={(nbId) => handleMove(movingNote, nbId)}
          onClose={() => setMovingNote(null)}
        />
      )}
    </div>
  );
}

// Sentinel used as the sync deduplication key on a fresh device before the default
// notebook arrives via the first pull. The actual account scope comes from the bearer token.
const INITIAL_SYNC_SENTINEL = '00000000-0000-4000-8000-000000000000' as NotebookId;

export function AuthedShell() {
  const sessionState = useAuthStore((s) => s.sessionState);
  const _ready = useNotebookStore((s) => s._ready);
  const currentNotebookId = useNotebookStore((s) => s.currentNotebookId);
  const initNotebook = useNotebookStore((s) => s.init);
  const notebook = useCurrentNotebook();
  const notebookName = currentNotebookId === null ? 'All Notes' : (notebook?.name ?? '…');
  // navOpen / DrawerNav is desktop-only (mobile uses BottomNav via CSS)
  const [navOpen, setNavOpen] = useState(false);
  // overlayOpen / FullScreenNav is mobile-only — the global 3-dot menu (#69 nav gap-fill)
  const [overlayOpen, setOverlayOpen] = useState(false);
  const navigate = useNavigate();
  // Device class drives the structural fork: desktop = persistent 3-region master-detail; mobile =
  // single-column push + bottom-sheet nav. Called before the early returns (rules-of-hooks).
  const isDesktop = useIsDesktop();
  // #82: the GLOBAL shell__bar is the single mobile note bar (editor__meta is hidden on mobile). On the note
  // route we surface version-history here (next to ⋯) via a ?history URL param NoteRoute reads. (Desktop uses
  // the 3-region shell — no shell__bar — and keeps its own editor__meta.)
  const onNoteRoute = useMatch('/note/:id') != null;
  const location = useLocation();
  // The Deck is ALWAYS present on a touch-first device — it IS the mobile bottom control surface (the
  // 'navigation' loadout while browsing, the editor keypad while editing). Presence is gated ONLY by
  // modality (touch-first), NOT by the custom-keyboard setting: that setting picks keypad-vs-native
  // keyboard INSIDE the editor (ProseMirrorEditor), it changes nothing at the shell. Gate = touch-first
  // modality (not window width) — a narrow laptop window is a hardware-keyboard machine and keeps the
  // standard nav + native keyboard, never the Deck.
  const touchPrimary = useTouchPrimary();
  const deckActive = touchPrimary;
  // body.deck-custom = "the Deck occupies the bottom slot": it retires the legacy standalone BottomNav
  // (styles.css) and reserves the browsing shell's bottom padding. Driven by Deck PRESENCE, independent
  // of the keyboard being up/down (a toggle-driven hide flashed the nav back under Jim's thumb). The
  // 'navigation' loadout (DeckHostProvider, below) carries search/new-note while browsing.
  useEffect(() => {
    document.body.classList.toggle('deck-custom', deckActive);
    return () => { document.body.classList.remove('deck-custom'); };
  }, [deckActive]);
  // Keypad mode (setting ON *and* touch-first *and* installed PWA — the ONE shared gate, useKeypadMode):
  // editor keypad vs native keyboard. At the SHELL it's read for ONE thing — suppress the Deck on the note
  // route whenever the editor is in NATIVE mode (setting off, OR a plain mobile browser tab, OR a hardware
  // keyboard). There the editor owns the bottom with its own sticky MobileEditorBar + summons the native
  // keyboard, and a viewport-fixed Deck would float over that bar / behind the keyboard. Keep the Deck
  // MOUNTED (host intact) but CSS-hide it there. This is the SAME gate the editor uses, so shell and editor
  // can't disagree about whether the keypad is up.
  const keypadMode = useKeypadMode();
  const suppressDeck = deckActive && onNoteRoute && !keypadMode;
  useEffect(() => {
    document.body.classList.toggle('deck-suppressed', suppressDeck);
    return () => { document.body.classList.remove('deck-suppressed'); };
  }, [suppressDeck]);

  // Load the device-local current notebook from IDB on first mount (with localStorage migration).
  useEffect(() => { void initNotebook(); }, [initNotebook]);

  // Start sync triggers as soon as the notebook pointer IDB read is done — even on a fresh
  // device with no current notebook. Sync is account-scoped (bearer token); notebookId is
  // only a push hint. The first pull delivers notebooks → mergeNotebooks auto-selects the
  // default → currentNotebookId goes from null → real ID → effect restarts with the real key.
  const syncKey = currentNotebookId ?? INITIAL_SYNC_SENTINEL;
  useEffect(() => {
    if (!_ready) return;
    // #89: in the revoked ('signed-out, resume sync') mode, do NOT start the triggers — startSyncTriggers
    // calls resumeSync() (lifting init()'s suspend) + polls a dead session. Sync stays hard-gated until a
    // full re-login flips sessionState to 'active' and this effect re-runs to start it (draining the queue).
    if (sessionState === 'revoked') return;
    return startSyncTriggers(syncKey);
  }, [_ready, syncKey, sessionState]);

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
        {/* Upload-first large-file progress (direct-r2-upload.md §6.3): transient pills for in-flight
            direct-to-R2 uploads; persists across navigation while a big file streams. */}
        <UploadProgressHost />
      </>
    );
  }

  // MOBILE / tablet-portrait: single-column, route-driven (note pushes over the list) + bottom-sheet nav.
  // The Deck (touch-first — always present, NOT the custom-keyboard setting) mounts ONCE here via
  // DeckHostProvider — above <Routes> so it persists across route changes: the navigation loadout while
  // browsing, the editor's keypad while a note is open (or suppressed on the note route in native mode).
  return (
    <DeckHostProvider enabled={deckActive}>
    <div className="shell">
      {/* Desktop: left-drawer nav (hidden on mobile via CSS). Mobile: BottomNav below. */}
      <DrawerNav open={navOpen} onClose={() => setNavOpen(false)} />
      {/* Mobile-only full-screen nav overlay (#69 global nav — visible even in deck-custom mode). */}
      <FullScreenNav open={overlayOpen} onClose={() => setOverlayOpen(false)} />

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
          {/* #82: on the note route, version-history moves UP here (editor__meta is hidden on mobile). Sets
              ?history on the current /note/:id URL; NoteRoute opens its HistoryPanel on that param. */}
          {onNoteRoute && (
            <button
              className="shell__nav-btn shell__nav-btn--mobile-only"
              onClick={() => navigate(`${location.pathname}?history`)}
              aria-label="Version history"
            >
              <VersionHistory size={20} />
            </button>
          )}
          {/* Global 3-dot nav button — mobile-only (#69 gap-fill: stays visible in body.deck-custom). */}
          <button
            className="shell__nav-btn shell__nav-btn--mobile-only"
            onClick={() => setOverlayOpen(true)}
            aria-label="Open navigation"
            aria-expanded={overlayOpen}
          >
            <Ellipsis size={24} />
          </button>
        </div>
      </header>

      <main className="shell__main">
        <Routes>
          <Route path="/new" element={<NewNote />} />
          <Route
            path="/note/:id"
            element={
              // Skeleton (not a spinner-flash): an empty editor surface so layout doesn't jump; the editor
              // chunk loads near-instantly from SW precache on warm/offline loads.
              <Suspense fallback={<div className="editor__pm" aria-busy="true" />}>
                <NoteRoute />
              </Suspense>
            }
          />
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

      {/* Upload-first large-file progress (direct-r2-upload.md §6.3): transient "uploading… NN%" pills for
          in-flight direct-to-R2 uploads; persists across route changes while a big file streams. */}
      <UploadProgressHost />
    </div>
    </DeckHostProvider>
  );
}
