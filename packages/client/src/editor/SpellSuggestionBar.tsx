/**
 * Spellcheck suggestion bar (#69 §5.1) — the Deck TOP-SLOT presentation of suggestions, like the native
 * iOS predictive bar: a horizontally scrollable row of suggestion pills. It's ONE occupant of the Deck's
 * top-slot layer (alongside the formatting submenu + the future voice waveform), not a bespoke overlay —
 * the host puts it in KeypadLoadout's `topSlot`. Reuses the engine lookup + the slice-3 replace seam; this
 * is presentation only.
 *
 * pointerdown + preventDefault keeps the host editor focused so the one-txn replace lands in place.
 */
interface SpellSuggestionBarProps {
  word: string;
  suggestions: string[];
  onPick: (word: string) => void;
  /** A trailing, visually-distinct action pill at the END of the bar (§5.2 "+ Add to dictionary"). The
   *  bar is intentionally NOT suggestions-only so that action lands with zero rework. Optional/unused now. */
  trailing?: React.ReactNode;
}

export function SpellSuggestionBar({ word, suggestions, onPick, trailing }: SpellSuggestionBarProps) {
  return (
    <div className="spell-bar" role="listbox" aria-label={`Suggestions for ${word}`}>
      {suggestions.length === 0 ? (
        <span className="spell-bar__empty">No suggestions</span>
      ) : (
        suggestions.map((s) => (
          <button
            key={s}
            type="button"
            role="option"
            aria-selected={false}
            className="spell-bar__pill"
            onPointerDown={(e) => { e.preventDefault(); onPick(s); }}
          >
            {s}
          </button>
        ))
      )}
      {trailing != null && <span className="spell-bar__trailing">{trailing}</span>}
    </div>
  );
}
