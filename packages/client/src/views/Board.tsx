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
import { useCustomReorder } from '../lib/dnd/useCustomReorder.js';
import type { useSortableRow as UseSortableRow } from '../lib/dnd/customReorderImpl.js';
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
  // Custom-order drag-reorder (ROAD-0019) — SAME lazy dnd-kit chunk as HomeView (ONE wiring, one perf gate).
  // Masonry layout → per-item directionBiased collision. Armed only in 'custom' sort; null until the module
  // resolves, so cards render plain first. useMeasuredGridSpans stays the layout owner; recompute is driven by
  // the ResizeObserver as spans change during drag (dnd-kit reorders DOM, the observer re-measures).
  const reorderEnabled = activeSort === 'custom';
  const reorder = useCustomReorder(reorderEnabled);

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
        ((cells) =>
          // In 'custom' sort with the dnd-kit chunk resolved, wrap the grid in the reorder provider so a card
          // drag reorders → reorderCustom. Otherwise render the SAME plain cells (perf gate preserved).
          reorderEnabled && reorder ? (
            <reorder.CustomReorderProvider notes={notes}>
              <ul className="board board--reorderable" aria-label="Notes">{cells}</ul>
            </reorder.CustomReorderProvider>
          ) : (
            <ul className="board" aria-label="Notes">{cells}</ul>
          ))(
          notes.map((note, index) => {
            const cellProps: BoardCellProps = {
              note,
              index,
              selected: note.id === openNoteId,
              registerMeasuredCell,
            };
            return reorderEnabled && reorder ? (
              <SortableBoardCell key={note.id} useSortableRow={reorder.useSortableRow} {...cellProps} />
            ) : (
              <BoardCell key={note.id} {...cellProps} />
            );
          }),
        )
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

/** Everything one board cell needs. Shared by the plain and the sortable cell wrappers. */
interface BoardCellProps {
  note: Note;
  index: number;
  selected: boolean;
  registerMeasuredCell: (id: string, el: HTMLElement | null) => void;
  /** When sortable, the reorder ref + dragging flag (supplied by SortableBoardCell). */
  sortableRef?: (element: Element | null) => void;
  isDragging?: boolean;
}

/** One board grid cell. The <li> is BOTH the measured-grid cell and (when sortable) the reorder element. */
function BoardCell({ note, selected, registerMeasuredCell, sortableRef, isDragging }: BoardCellProps) {
  return (
    <li
      ref={(el) => {
        // Merge refs: useMeasuredGridSpans owns layout (row spans); dnd-kit measures/moves the same element.
        registerMeasuredCell(note.id, el);
        sortableRef?.(el);
      }}
      className={`board__cell${isDragging ? ' board__cell--dragging' : ''}`}
    >
      <Link
        to={`/note/${note.id}`}
        className={`board__card${selected ? ' board__card--selected' : ''}`}
        aria-current={selected ? 'page' : undefined}
      >
        <BoardCard note={note} />
        <ConflictBadgeSlot note={note} />
      </Link>
    </li>
  );
}

/**
 * Sortable variant — calls the lazy module's useSortableRow at the top level (only rendered when the module
 * is loaded, so the hook set is stable) with the masonry layout → directionBiased collision, and merges its
 * ref into BoardCell alongside the measured-grid ref.
 */
function SortableBoardCell({
  useSortableRow, ...cellProps
}: BoardCellProps & { useSortableRow: typeof UseSortableRow }) {
  const { ref, isDragging } = useSortableRow({ id: cellProps.note.id, index: cellProps.index, layout: 'masonry' });
  return <BoardCell {...cellProps} sortableRef={ref} isDragging={isDragging} />;
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
