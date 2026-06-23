import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Spellcheck suggestion popover (#69 §5) — a small floating list anchored at a tapped misspelling. Dumb +
 * presentational: the editor computes the suggestions (via the engine) + the anchor coords and hands them
 * here; tapping a suggestion calls onPick (the editor replaces the word in one txn). Themed with app
 * tokens; ≥44px-ish tap rows with ≥16px text (consistent with the toolbar tap-target work + iOS no-zoom).
 * Closes on outside tap or Escape.
 */
interface SpellSuggestionPopoverProps {
  x: number;
  y: number;
  word: string;
  suggestions: string[];
  onPick: (word: string) => void;
  onClose: () => void;
}

export function SpellSuggestionPopover({ x, y, word, suggestions, onPick, onClose }: SpellSuggestionPopoverProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest('.spell-popover')) onClose();
    };
    document.addEventListener('keydown', onKey);
    // Defer the outside-tap listener so the opening tap itself doesn't immediately close it.
    const id = setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);

  return createPortal(
    <div className="spell-popover" style={{ left: x, top: y }} role="listbox" aria-label={`Suggestions for ${word}`}>
      {suggestions.length === 0 ? (
        <div className="spell-popover__empty">No suggestions</div>
      ) : (
        suggestions.map((s) => (
          <button
            key={s}
            type="button"
            role="option"
            aria-selected={false}
            className="spell-popover__item"
            // pointerdown + preventDefault so the editor selection/focus isn't disturbed before we replace.
            onPointerDown={(e) => { e.preventDefault(); onPick(s); }}
          >
            {s}
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
