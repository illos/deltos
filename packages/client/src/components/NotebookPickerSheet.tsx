import type { NotebookId } from '@deltos/shared';

/**
 * NotebookPickerSheet (#78) — a clean mobile bottom sheet for moving a note to another notebook (replaces
 * the inline move-picker removed in #76). Opened from the SwipeRow left Move seam; lists "All Notes"
 * (uncategorize → notebookId null) + each notebook, and calls onSelect with the chosen id. The note's
 * current notebook is marked + disabled. Presentational only — the host owns the move mutation.
 */
interface NotebookPickerSheetProps {
  notebooks: ReadonlyArray<{ id: NotebookId; name: string }>;
  /** The note's current notebook (null = uncategorized) — marked + disabled in the list. */
  currentNotebookId: NotebookId | null;
  /** Chosen target: null = All Notes (uncategorize); a real id = that notebook. */
  onSelect: (notebookId: NotebookId | null) => void;
  onClose: () => void;
}

export function NotebookPickerSheet({ notebooks, currentNotebookId, onSelect, onClose }: NotebookPickerSheetProps) {
  return (
    <div className="nb-sheet" role="dialog" aria-modal="true" aria-label="Move note to notebook">
      <div className="nb-sheet__backdrop" onClick={onClose} />
      <div className="nb-sheet__panel">
        <p className="nb-sheet__title">Move to notebook</p>
        <ul className="nb-sheet__list">
          <li>
            <button
              type="button"
              className={`nb-sheet__row${currentNotebookId === null ? ' nb-sheet__row--current' : ''}`}
              disabled={currentNotebookId === null}
              onClick={() => onSelect(null)}
            >
              All Notes <span className="nb-sheet__hint">uncategorize</span>
            </button>
          </li>
          {notebooks.map((nb) => (
            <li key={nb.id}>
              <button
                type="button"
                className={`nb-sheet__row${nb.id === currentNotebookId ? ' nb-sheet__row--current' : ''}`}
                disabled={nb.id === currentNotebookId}
                onClick={() => onSelect(nb.id)}
              >
                {nb.name}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="nb-sheet__cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
