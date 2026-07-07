import { Link, useNavigate } from 'react-router-dom';
import type { NoteId } from '@deltos/shared';
import { SyncIndicator } from './SyncIndicator.js';
// `Link as ShareLink` — the icons module's Link (a chain-link glyph, our Share affordance) aliased to
// avoid colliding with react-router's Link imported above.
import { VersionHistory, Info, Trash, Expand, Collapse, PopOut, Link as ShareLink } from '../icons/index.js';

/**
 * The §3 note meta toolbar — the DESKTOP-ONLY row of note controls (#82): sync indicator + version-history +
 * delete + the ROAD-0010 full-window entry/exit controls. Extracted from NoteRoute (was inline JSX) so BOTH
 * the block editor AND the file-note view get the identical bar above them — same DOM, same handlers.
 *
 * Route-derived by design: the full-screen / pop-out / exit targets are URL paths off `noteId` (no new store).
 * NoteRoute keeps the desktop-only gate + owns the handlers (history-open, soft-delete); this component is
 * pure presentation over them.
 */
export interface NoteMetaBarProps {
  /** The open note's id — drives the `/note/:id/full` full-window + pop-out + exit targets. */
  noteId: NoteId;
  /**
   * ROAD-0010 chrome variant. When true (the bare `/note/:id/full` view) the entry controls are REPLACED by a
   * single back-to-regular EXIT control (no full-screen-inside-full-screen).
   */
  isFull: boolean;
  /** Open the version-history panel (NoteRoute owns the `showHistory` state). */
  onShowHistory: () => void;
  /** Open the per-note info panel (NoteRoute owns the `showInfo` state). */
  onShowInfo: () => void;
  /** Soft-delete → Trash (NoteRoute owns the recoverable delete + Undo toast). */
  onDelete: () => void;
}

export function NoteMetaBar({ noteId, isFull, onShowHistory, onShowInfo, onDelete }: NoteMetaBarProps) {
  const navigate = useNavigate();
  return (
    <header className="editor__meta">
      <div className="editor__meta-end">
        {/* Relocated sync indicator (was the top-bar pill; the §3 home is its place now). */}
        <SyncIndicator />
        <button className="editor__meta-btn" onClick={onShowHistory} aria-label="Version history">
          <VersionHistory size={18} />
        </button>
        {/* Per-note info (ⓘ) — sits beside history; opens the full-screen InfoPanel. */}
        <button className="editor__meta-btn" onClick={onShowInfo} aria-label="Note info">
          <Info size={18} />
        </button>
        {/* Share (ROAD-0011 P2 + ROAD-0017) — opens the combined Share screen (share links + export) via the
            ?share URL param (the same route seam History/Info use). One button folds in what were the adjacent
            Share + Export affordances. Its eventual home is the ROAD-0013 "…" context menu. */}
        <button
          className="editor__meta-btn"
          onClick={() => navigate(`/note/${noteId}?share`)}
          aria-label="Share note"
        >
          <ShareLink size={18} />
        </button>
        {/* Desktop delete trashcan, next to history. Soft-delete → Trash, recoverable. */}
        <button className="editor__meta-btn" onClick={onDelete} aria-label="Delete note">
          <Trash size={18} />
        </button>
        {/* ROAD-0010 full-window controls. In the full view the entry controls are REPLACED by a
            single back-to-regular EXIT control (no full-screen-inside-full-screen). */}
        {isFull ? (
          <Link
            to={`/note/${noteId}`}
            className="editor__meta-btn"
            aria-label="Exit full screen"
          >
            <Collapse size={18} />
          </Link>
        ) : (
          <>
            {/* Full screen — navigate the CURRENT window to the bare full-window view in place. */}
            <button
              className="editor__meta-btn"
              onClick={() => navigate(`/note/${noteId}/full`)}
              aria-label="Full screen"
            >
              <Expand size={18} />
            </button>
            {/* Pop out — the same full-window view in its own popup window. */}
            <button
              className="editor__meta-btn"
              onClick={() =>
                window.open(`/note/${noteId}/full`, '_blank', 'popup,width=900,height=760')
              }
              aria-label="Pop out"
            >
              <PopOut size={18} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
