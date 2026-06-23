/**
 * LinkEntryBar (#69 Deck link fix) — the inline URL-entry surface for creating a link in the custom
 * keyboard. window.prompt (the old linkCommand path) is unreliable in an installed PWA / inputmode=none, so
 * this replaces it: a top-slot occupant (same layer the spell bar uses) showing the URL as it's typed ON THE
 * DECK KEYPAD (the host routes keypad keys into a buffer while this is open — no native keyboard), with apply
 * (→) and cancel (×) controls. Enter on the keypad also applies.
 *
 * Presentational only: the host owns the buffer + the apply/cancel actions (it has the PM selection + the
 * scheme-safe normalizer). Buttons preventDefault on pointerdown so the editor keeps focus and the keypad
 * stays live.
 */
interface LinkEntryBarProps {
  /** The URL typed so far (host-owned buffer, fed by the Deck keypad). */
  url: string;
  /** Apply the link (→ button / keypad Enter). */
  onSubmit: () => void;
  /** Abandon link entry (× button). */
  onCancel: () => void;
}

export function LinkEntryBar({ url, onSubmit, onCancel }: LinkEntryBarProps) {
  return (
    <div className="link-entry-bar" role="group" aria-label="Add link">
      <button
        type="button"
        className="link-entry-bar__btn link-entry-bar__cancel"
        aria-label="Cancel link"
        onPointerDown={(e) => { e.preventDefault(); onCancel(); }}
      >
        ×
      </button>
      <span className="link-entry-bar__field">
        {url
          ? <span className="link-entry-bar__url">{url}</span>
          : <span className="link-entry-bar__placeholder">Type the link URL…</span>}
        <span className="link-entry-bar__caret" aria-hidden="true" />
      </span>
      <button
        type="button"
        className="link-entry-bar__btn link-entry-bar__apply"
        aria-label="Apply link"
        disabled={!url.trim()}
        onPointerDown={(e) => { e.preventDefault(); onSubmit(); }}
      >
        →
      </button>
    </div>
  );
}
