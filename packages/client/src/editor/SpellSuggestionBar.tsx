import { useRef } from 'react';

/**
 * Spellcheck suggestion bar (#69 §5.1) — the Deck TOP-SLOT presentation of suggestions, like the native
 * iOS predictive bar: a horizontally scrollable row of suggestion pills. It's ONE occupant of the Deck's
 * top-slot layer (alongside the formatting submenu + the future voice waveform), not a bespoke overlay —
 * the host puts it in KeypadLoadout's `topSlot`. Reuses the engine lookup + the slice-3 replace seam; this
 * is presentation only.
 *
 * TAP-NOT-SCROLL (Jim feel-test): the bar is horizontally SCROLLABLE, so a pill must apply only on a
 * deliberate TAP — NOT on pointerdown (which made scrolling instantly mis-apply). We record the pointerdown
 * position and apply on pointerup only if the pointer barely moved (< TAP_MOVE_PX); a larger move was a
 * scroll → no apply. (CSS `touch-action: pan-x` on .spell-bar lets it actually pan inside the Deck, which
 * otherwise sets touch-action:none.) The Deck's container-level preventDefault keeps the editor focused.
 */
const TAP_MOVE_PX = 10;

interface SpellSuggestionBarProps {
  word: string;
  suggestions: string[];
  onPick: (word: string) => void;
  /** §5.2: when provided, render a trailing, visually-distinct [+ Add to dictionary] action at the end of
   *  the bar. It goes through the SAME tap-not-scroll detection as the pills. */
  onAddToDictionary?: () => void;
}

export function SpellSuggestionBar({ word, suggestions, onPick, onAddToDictionary }: SpellSuggestionBarProps) {
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => { downAt.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e: React.PointerEvent) => {
    const start = downAt.current;
    downAt.current = null;
    if (!start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) >= TAP_MOVE_PX) return; // a scroll, not a tap
    const el = e.target as HTMLElement | null;
    if (el?.closest('.spell-bar__add')) { onAddToDictionary?.(); return; }
    const w = el?.closest('.spell-bar__pill')?.getAttribute('data-word');
    if (w) onPick(w);
  };

  return (
    <div
      className="spell-bar"
      role="listbox"
      aria-label={`Suggestions for ${word}`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      {suggestions.length === 0 ? (
        <span className="spell-bar__empty">No suggestions</span>
      ) : (
        suggestions.map((s) => (
          <button key={s} type="button" role="option" aria-selected={false} className="spell-bar__pill" data-word={s}>
            {s}
          </button>
        ))
      )}
      {onAddToDictionary && (
        <button type="button" className="spell-bar__add" aria-label={`Add "${word}" to dictionary`}>
          + Add to dictionary
        </button>
      )}
    </div>
  );
}
