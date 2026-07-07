import { useEffect, useState, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
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
// PROBE (disposable): /probe/nav — mobile nav-gesture feel test. LAZY + off-track (own chunk, ZERO
// first-load cost), reached by URL only (not in any nav/menu). Delete src/probe/ + this line + the
// onProbeNav block below to remove it in one commit.
const ProbeNavRoute = lazy(() =>
  import('./probe/ProbeNavRoute.js').then((m) => ({ default: m.ProbeNavRoute })),
);
// NOTE: OAuth consent is NO LONGER a route in this app. It is a SEPARATE standalone surface served at
// /oauth/* (oauth-consent-surface-separation.md / DEC-0005), decoupled from this router / shell / service
// worker. The notes SW passes /oauth/ navigations through to the network (sw.ts denylist).
import { DrawerNav } from './components/DrawerNav.js';
import { ContextMenuSheet } from './components/ContextMenuSheet.js';
import { BottomNav } from './components/BottomNav.js';
import { ThreeRegionShell } from './components/ThreeRegionShell.js';
import { DeckHostProvider, useDeckHost, DECK_SEARCH_CONTEXT } from './components/DeckHost.js';
import { NavSheetProvider, NavSheet } from './components/NavSheet.js';
// Direct module import (NOT the deck/index barrel) so the shell's first-load bundle doesn't pull the
// barrel's voice/spellcheck re-exports — only the keys-only loadout + its Keypad.
import { SearchKeypadLoadout } from './deck/loadouts/SearchKeypadLoadout.js';
import { SearchResultsBody } from './components/SearchResults.js';
import { buildQueryKeyActions } from './lib/queryKeyActions.js';
import { useSearchModeStore } from './lib/searchModeStore.js';
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
// `Link as ShareLink` — the icons module's chain-link glyph, our Share affordance, aliased to avoid
// colliding with react-router's Link imported above.
import { ComposeNew, Search, Ellipsis, VersionHistory, Info, Link as ShareLink } from './icons/index.js';
import { SyncIndicator } from './components/SyncIndicator.js';
import { SessionStatus } from './components/SessionStatus.js';
import { ConflictToastHostSlot } from './components/ConflictToastHostSlot.js';
import { UploadProgressHost } from './components/UploadProgressHost.js';
import { Lightbox } from './components/Lightbox.js';
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
  // PROBE (disposable): /probe/nav bypasses the boot/auth gate entirely — it's a gesture playground
  // with dummy data only (no store reads), and it must be reachable on a static tailnet serve where
  // no auth API exists. AFTER all hooks (rules-of-hooks: the early return must not skip any), ABOVE
  // the boot switch so even the cold-boot spinner can't hold it. Delete with the probe glue.
  const onProbeNav = useMatch('/probe/nav') != null;
  if (onProbeNav) {
    return (
      <Suspense fallback={null}>
        <ProbeNavRoute />
      </Suspense>
    );
  }

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

  // ── In-place search ─────────────────────────────────────────────────────────────────────────────
  // Search is a mode over THIS list, not a route: the list stays put until the first character, then
  // swaps for results RIGHT HERE (the middle list pane on desktop, the single column on mobile) — never
  // the right note pane. MOBILE: entry via the Deck nav Search slot (shared store flag) or the pill; the
  // pill morphs into the live field on open. In keypad mode the field is inputMode=none and the Deck flips
  // to a keys-only 'search' loadout; in native mode it's a plain inputMode=search field (no Deck publish).
  // DESKTOP: no open ceremony — the field is ALWAYS a live input (mouse+keyboard), so results render in
  // place in the list pane instead of the old (wrong) navigate('/search') into the right note region.
  const keypadMode = useKeypadMode();
  const { publishEditor } = useDeckHost();
  const searchOpen = useSearchModeStore((s) => s.open);
  const setSearchOpen = useSearchModeStore((s) => s.setOpen);
  // inPlaceSearch = the MOBILE search-mode flag (drives the Deck publish + focus-on-open). liveSearch =
  // "render the real input + let a non-empty query show results" — always on for desktop, flag-gated on mobile.
  const inPlaceSearch = searchOpen && !isDesktop;
  const liveSearch = inPlaceSearch || isDesktop;
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Stable KeyActions for the keys-only keypad — edits the plain query string (built once).
  const queryActions = useMemo(() => buildQueryKeyActions(setQuery), []);
  // 200ms debounce (matches SearchRoute) before the shared body runs the fuzzy engine.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);
  // On open: clear + focus the field (keypad keys preventDefault, so focus stays → the caret shows and,
  // in keypad mode, no native keyboard is summoned by inputMode=none). Reset on close.
  useEffect(() => {
    setQuery('');
    if (!inPlaceSearch) return undefined;
    const raf = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [inPlaceSearch]);
  // Clear the query when the notebook changes so a lingering desktop search doesn't mask a notebook switch
  // (desktop keeps the field live across notebook clicks; without this the stale results would hide the list).
  useEffect(() => { setQuery(''); }, [notebookId]);
  // Publish the keys-only 'search' loadout to the Deck while in-place search is open in KEYPAD mode;
  // withdraw (→ nav context) on close/unmount. Native mode summons the OS keyboard instead (no publish).
  useEffect(() => {
    if (!inPlaceSearch || !keypadMode) return undefined;
    publishEditor({
      context: DECK_SEARCH_CONTEXT,
      loadouts: { [DECK_SEARCH_CONTEXT]: <SearchKeypadLoadout actions={queryActions} /> },
    });
    return () => publishEditor(null);
  }, [inPlaceSearch, keypadMode, publishEditor, queryActions]);
  // Exit search on unmount — peeking into a result note (or any route change) must not strand the Deck
  // in the 'search' context; the publish effect's cleanup restores nav, this clears the shared flag.
  useEffect(() => () => { setSearchOpen(false); }, [setSearchOpen]);
  const closeSearch = useCallback(() => { setSearchOpen(false); setQuery(''); }, [setSearchOpen]);
  // The list swaps for results on the first character (still in search mode when cleared → list returns).
  const showResults = liveSearch && query.trim().length > 0;

  return (
    <div className={`home${fileDragOver ? ' home--file-drag' : ''}${inPlaceSearch ? ' home--searching' : ''}`} {...fileDropProps}>
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

      {/* §2 search field. Desktop: ALWAYS a live input — results render in place in this (list) pane. Mobile:
          a pill that enters in-place search mode and, while open, morphs into the live input right here; the
          note list below stays put until the first character is typed. */}
      <div className="home__search">
        {liveSearch ? (
          <div className="home__search-field home__search-field--active">
            <Search className="home__search-icon" size={15} />
            <input
              ref={searchInputRef}
              className="home__search-input"
              type="search"
              // Keypad mode → suppress the OS keyboard (the Deck's keys drive the query); native mode →
              // a plain search input that summons the OS keyboard on focus (cheap fallback).
              inputMode={keypadMode ? 'none' : 'search'}
              placeholder="Search notes…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Search notes"
            />
            {/* ✕ — mobile: exit search mode (back to the pill). Desktop: clear the query (the field stays,
                since there is no "closed" state), only shown when there's something to clear. */}
            {(inPlaceSearch || query) && (
              <button
                className="home__search-close"
                aria-label={isDesktop ? 'Clear search' : 'Close search'}
                onClick={isDesktop ? () => { setQuery(''); searchInputRef.current?.focus(); } : closeSearch}
              >
                ✕
              </button>
            )}
          </div>
        ) : (
          <button className="home__search-field" onClick={() => setSearchOpen(true)}>
            <Search className="home__search-icon" size={15} />
            <span className="home__search-placeholder">Search</span>
          </button>
        )}
      </div>

      {showResults ? (
        <SearchResultsBody debouncedQuery={debouncedQuery} showHintWhenEmpty={false} />
      ) : notes.length === 0 ? (
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
  // optionsOpen / ContextMenuSheet is mobile-only — the top-bar "…" now opens the CONTEXTUAL options
  // surface (ROAD-0011: the drag-up NavSheet is THE navigation; "…" is repurposed for notebook/note
  // options — rename / organize / display / sharing land there later; v1 is the empty shell + close).
  const [optionsOpen, setOptionsOpen] = useState(false);
  const navigate = useNavigate();
  // Device class drives the structural fork: desktop = persistent 3-region master-detail; mobile =
  // single-column push + bottom-sheet nav. Called before the early returns (rules-of-hooks).
  const isDesktop = useIsDesktop();
  // #82: the GLOBAL shell__bar is the single mobile note bar (editor__meta is hidden on mobile). On the note
  // route we surface version-history here (next to ⋯) via a ?history URL param NoteRoute reads. (Desktop uses
  // the 3-region shell — no shell__bar — and keeps its own editor__meta.)
  const onNoteRoute = useMatch('/note/:id') != null;
  // ROAD-0010: the bare full-window note view (/note/:id/full) takes over the ENTIRE window — no
  // 3-region shell, no mobile shell chrome. It renders as a route INSIDE AuthedShell (so every sync /
  // notebook-init / auth effect above still runs — this is the same app context, not a second React
  // root), just WITHOUT the ThreeRegionShell / mobile-shell wrapper. useMatch('/note/:id') does NOT
  // match the deeper /note/:id/full pattern, so onNoteRoute stays false here (no shell-bar history seam).
  const onFullNote = useMatch('/note/:id/full') != null;
  // PROBE (disposable): /probe/nav takes over the ENTIRE window (like the full-note view) so the gesture
  // surface has no BottomNav / Deck / shell chrome fighting it. Reached by URL only.
  const onProbeNav = useMatch('/probe/nav') != null;
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
  // editor keypad vs native keyboard. At the SHELL it's read for ONE thing — decide where the Deck rides.
  //   • KEYPAD mode (installed PWA + setting on): the Deck owns the BOTTOM slot exactly as before (the
  //     inputmode=none editor summons no native keyboard, so nothing fights it at the bottom).
  //   • NATIVE mode (setting off, OR a plain mobile browser tab, OR a hardware keyboard): placement is
  //     CONTEXT-aware (Jim), because the top-bar was only ever needed to escape the keyboard while EDITING:
  //       – EDITING (on the note route): the editor rides the OS keyboard + its own toolbar, and Safari owns
  //         a bottom URL bar — a bottom-fixed Deck would fight all three. So the Deck flips to a compact
  //         sticky bar at the TOP (body.deck-top → CSS), carrying the editor TOOLBAR (published by
  //         ProseMirrorEditor). This is the case the old suppress-hide handled; the top bar replaced it.
  //       – BROWSING (note list / All-Notes / notebooks nav — no note open): NO keyboard is up, so the
  //         top-escape isn't needed. The Deck rides the BOTTOM (its default slot), exactly as it did
  //         pre-513026c while browsing — the nav loadout back under the thumb. Restored per Jim's feedback.
  //     So deck-top is gated on onNoteRoute: top while a note is open, bottom while browsing. This is the
  //     SAME useKeypadMode gate the editor reads, so the shell and the editor never disagree about which
  //     keyboard is up. (deck-custom still means "Deck present" and reserves the bottom browsing padding.)
  const keypadMode = useKeypadMode();
  const deckTop = deckActive && !keypadMode && onNoteRoute;
  useEffect(() => {
    document.body.classList.toggle('deck-top', deckTop);
    return () => { document.body.classList.remove('deck-top'); };
  }, [deckTop]);

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

  // ROAD-0010 full-window note view — bypasses BOTH the desktop 3-region shell and the mobile shell
  // chrome. It reuses NoteRoute's SAME lazy chunk (variant="full" swaps the entry controls for a single
  // back-to-regular exit); no forked editor. The route lives here (inside AuthedShell) so the sync /
  // notebook / auth providers + effects above are all live — a popped-out window is just a second same-
  // origin app context (like a second tab), and edits reconcile through the existing liveQuery path.
  if (onFullNote) {
    return (
      <>
        <Routes>
          <Route
            path="/note/:id/full"
            element={
              <Suspense fallback={<div className="editor__pm" aria-busy="true" />}>
                <NoteRoute variant="full" />
              </Suspense>
            }
          />
        </Routes>
        <ConflictToastHostSlot />
        <UploadProgressHost />
        <Lightbox />
      </>
    );
  }

  // PROBE (disposable): full-window nav-gesture feel test — no shell chrome (own lazy chunk).
  if (onProbeNav) {
    return (
      <Suspense fallback={<div className="auth"><div className="auth__spinner" aria-label="Loading" /></div>}>
        <ProbeNavRoute />
      </Suspense>
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
        <Lightbox />
      </>
    );
  }

  // MOBILE / tablet-portrait: single-column, route-driven (note pushes over the list) + bottom-sheet nav.
  // The Deck (touch-first — always present, NOT the custom-keyboard setting) mounts ONCE here via
  // DeckHostProvider — above <Routes> so it persists across route changes: the navigation loadout while
  // browsing (BOTTOM slot), the editor's keypad while a note is open in keypad mode (BOTTOM), or, in
  // native mode with a note open, the editor TOOLBAR riding the TOP as a sticky bar — body.deck-top.
  // Drag-up nav sheet (ROAD-0011, Jim feel-pass): armed wherever the Deck rides the BOTTOM on the touch
  // shell — BOTH while browsing (nav loadout) AND in the editor (keypad mode; the Deck keypad is Jim's
  // daily driver). It arms from the Deck's grabber affordance (DeckHost injects the handlers into the Deck
  // core, so the keypad placement gets it too) and, while browsing, also from the whole nav bar.
  //   EXCEPTION — native-keyboard editing (body.deck-top): there the Deck is a compact bar at the TOP, so a
  //   drag-UP off a top bar is nonsense → the gesture stays disabled in that one state (native mode is
  //   fallback-only per standing direction, so it stays cheap/conservative there). Desktop has no Deck at
  //   all → also off. Gate = Deck present AND not top-mode.
  // The provider wraps DeckHostProvider so the single sheet controller reaches BOTH the Deck (arm zone +
  // grabber, inside DeckHostProvider) and the <NavSheet/> surface in the shell chrome below.
  const navSheetEnabled = deckActive && !deckTop;
  return (
    <NavSheetProvider enabled={navSheetEnabled}>
    <DeckHostProvider enabled={deckActive}>
    <div className="shell">
      {/* Desktop: left-drawer nav (hidden on mobile via CSS). Mobile: BottomNav below. */}
      <DrawerNav open={navOpen} onClose={() => setNavOpen(false)} />
      {/* Mobile-only contextual options surface — opened by the top-bar "…" (ROAD-0011). */}
      <ContextMenuSheet open={optionsOpen} onClose={() => setOptionsOpen(false)} />

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
        {/* Mobile brand block (ROAD-0011 refinement): the δ deltos wordmark with the current notebook as a
            tiny caption directly UNDERNEATH (stacked, not side-by-side). The δ reuses .dt-wordmark-delta — the
            SAME accent-serif treatment as the desktop DrawerNav wordmark (tokens.css: color:var(--accent)) — so
            the mark is brand-coloured, not plain. The caption reuses .dt-label (mono/uppercase/faint, the app's
            small-label language) and truncates with an ellipsis, never wrapping. The column is tight
            (line-height:1) and stays well under the 44px nav-button row, so .shell__bar height is unchanged.
            "All Notes" (the synthetic default) renders the same way. */}
        <Link to="/" className="shell__brand" aria-label={`deltos — ${notebookName}`}>
          <span className="shell__mark">
            <span className="dt-wordmark-delta">δ</span> deltos
          </span>
          <span className="dt-label shell__nb-caption">{notebookName}</span>
        </Link>
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
          {/* Per-note Info (ⓘ) — mobile counterpart of the desktop meta-bar button. Sets ?info on the
              current /note/:id URL; NoteRoute opens its InfoPanel on that param (mirrors ?history). */}
          {onNoteRoute && (
            <button
              className="shell__nav-btn shell__nav-btn--mobile-only"
              onClick={() => navigate(`${location.pathname}?info`)}
              aria-label="Note info"
            >
              <Info size={20} />
            </button>
          )}
          {/* Per-note Share (ROAD-0011 P2) — mobile counterpart of the desktop meta-bar Share button. Sets
              ?share on the current /note/:id URL; NoteRoute opens its (lazy) SharesPanel on that param
              (mirrors ?history / ?info). Its eventual home is the ROAD-0013 "…" context menu. */}
          {onNoteRoute && (
            <button
              className="shell__nav-btn shell__nav-btn--mobile-only"
              onClick={() => navigate(`${location.pathname}?share`)}
              aria-label="Share note"
            >
              <ShareLink size={20} />
            </button>
          )}
          {/* "…" contextual-options button — mobile-only (stays visible in body.deck-custom). Opens the
              notebook/note options surface (ROAD-0011); navigation itself is the drag-up NavSheet now. */}
          <button
            className="shell__nav-btn shell__nav-btn--mobile-only"
            onClick={() => setOptionsOpen(true)}
            aria-label="Options"
            aria-expanded={optionsOpen}
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
          <Route
            path="/settings/:tab"
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

      {/* Drag-up nav sheet — the second entrance to the top-bar "…" pane (same NavContent). Always mounted
          (parked off-screen, inert) so the arming drag off the Deck nav zone can follow the finger; opens /
          dismisses via the shared NavSheetProvider controller. Renders null when the provider is disabled. */}
      <NavSheet />

      {/* TOAST-HOST MOUNT SLOT — gruntSys2 fills this with the conflict ToastHost for Part 2.
          Leave the slot; do not build the toast here. */}
      <ConflictToastHostSlot />

      {/* Upload-first large-file progress (direct-r2-upload.md §6.3): transient "uploading… NN%" pills for
          in-flight direct-to-R2 uploads; persists across route changes while a big file streams. */}
      <UploadProgressHost />

      {/* Full-screen image lightbox — renders null until an inline image is tapped (openLightbox). */}
      <Lightbox />
    </div>
    </DeckHostProvider>
    </NavSheetProvider>
  );
}
