import { lazy, Suspense, useMemo } from 'react';
import { Link, useMatch, useNavigate } from 'react-router-dom';
import type { Note, NotebookId } from '@deltos/shared';
import { isFileNote, isPinned } from '@deltos/shared';
import type { CollectionViewProps } from '../lib/collectionViews.js';
import { useNotes, useCurrentNotebook } from '../db/storeHooks.js';
import { sortNotes, coerceNoteSort } from '../lib/noteSort.js';
import { notePreview, formatSmartDate } from '../lib/notePreview.js';
import { useIsDesktop } from '../lib/useIsDesktop.js';
import { useMeasuredGridSpans } from '../lib/useMeasuredGridSpans.js';
import { FileNotePill } from '../components/FileNotePill.js';
import { ConflictBadgeSlot } from '../components/ConflictBadgeSlot.js';
import { Pin } from '../icons/index.js';
import './Board.css';

// LAZY: the note editor is the heaviest subtree — mount it inside the desktop popover the SAME lazy way the
// shells do (never static). This is inside the already-lazy Board chunk, so it's a nested split, still off the
// entry bundle.
const NoteRoute = lazy(() => import('../routes/NoteRoute.js').then((m) => ({ default: m.NoteRoute })));

/**
 * Board — the Google-Keep-style grid CollectionView (notebook-menu-and-keep-view.md §6). A NEW lazy off-track
 * view registered against the collection-view seam; NEVER static-imported into the entry (perf north star —
 * see registerBoardView.ts). It dissolves the middle list + right note panes into ONE responsive card grid.
 *
 * Ordering: the SAME `sortNotes(notes, mode)` every list surface uses (pin partition respected, active
 * per-notebook mode) — the Board can never drift from the List. Cards show title + preview + smart date + a
 * pin glyph (file notes render the FileNotePill), all pure token/`notePreview` reuse.
 *
 * DESKTOP note-open = popover-over-blur (§6.4): on desktop the list pane is gone in Board mode, so a card tap
 * opens the note as a centered modal over a blurred backdrop (reusing the overlay language), driven off the
 * `/note/:id` route match — deep links + back-button still work; closing navigates back to the board. MOBILE
 * stays full-screen: the Board only renders at `/` (a note open is a separate route that takes the column), so
 * a mobile card tap just navigates and the shell's route swaps in full-screen — no popover here.
 */
export function Board({ notebookId }: CollectionViewProps) {
  const allNotes = useNotes();
  const notebook = useCurrentNotebook();
  const isDesktop = useIsDesktop();
  const navigate = useNavigate();

  const activeSort = coerceNoteSort(notebookId === null ? null : notebook?.noteSort);
  const filtered = notebookId === null ? allNotes : allNotes.filter((n) => n.notebookId === notebookId);
  const notes = useMemo(() => sortNotes(filtered, activeSort), [filtered, activeSort]);
  const registerMeasuredCell = useMeasuredGridSpans(notes.map((note) => note.id).join('|'));

  // Desktop popover: the note open in the URL (works because Board renders even while /note/:id matches — the
  // desktop shell keeps the list region mounted). On mobile this stays null-effect: /note/:id is its own route.
  const noteMatch = useMatch('/note/:id');
  const openNoteId = noteMatch?.params.id ?? null;
  const showPopover = isDesktop && openNoteId !== null;

  return (
    <div className="board-view">
      {notes.length === 0 ? (
        <p className="board-view__empty">No notes yet.</p>
      ) : (
        <ul className="board" aria-label="Notes">
          {notes.map((note) => (
            <li
              key={note.id}
              ref={(el) => registerMeasuredCell(note.id, el)}
              className="board__cell"
            >
              <Link
                to={`/note/${note.id}`}
                className={`board__card${note.id === openNoteId ? ' board__card--selected' : ''}`}
                aria-current={note.id === openNoteId ? 'page' : undefined}
              >
                <BoardCard note={note} />
                <ConflictBadgeSlot note={note} />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Desktop note popover-over-blur — the single genuinely-new structural piece. Reuses the overlay
          language; dismiss = backdrop click + Escape → navigate back to the board url. */}
      {showPopover && (
        <div
          className="board-note-popover"
          role="dialog"
          aria-modal="true"
          aria-label="Note"
          onKeyDown={(e) => { if (e.key === 'Escape') navigate('/'); }}
        >
          <div className="board-note-popover__backdrop" onClick={() => navigate('/')} aria-hidden="true" />
          <div className="board-note-popover__panel">
            <Suspense fallback={<div className="editor__pm" aria-busy="true" />}>
              <NoteRoute />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}

/** One card's content: file notes → the artifact pill; prose notes → pin + title + date + preview. */
function BoardCard({ note }: { note: Note }) {
  if (isFileNote(note)) return <FileNotePill note={note} />;
  const { displayTitle, previewLine } = notePreview(note);
  return (
    <>
      <span className="board__card-title">
        {isPinned(note.properties) && <Pin size={12} className="board__card-pin" title="Pinned" />}
        {displayTitle}
      </span>
      {previewLine && <span className="board__card-preview">{previewLine}</span>}
      <span className="board__card-date">{formatSmartDate(note.updatedAt)}</span>
    </>
  );
}

// Re-export the NotebookId type consumers may want (keeps the lazy chunk self-contained for tooling).
export type { NotebookId };
