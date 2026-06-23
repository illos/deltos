/**
 * LinkEntryBar (#69 Deck link fix) — the inline URL+TITLE entry surface for creating a link in the custom
 * keyboard. window.prompt (the old linkCommand path) is unreliable in an installed PWA / inputmode=none, so
 * this replaces it: a top-slot occupant (same layer the spell bar uses) with two fields — the link's TITLE
 * (the visible, clickable text) and its URL — both typed ON THE DECK KEYPAD (the host routes keypad keys
 * into whichever field is active — no native keyboard). Tap a field to focus it; keypad Enter advances
 * URL→Title→apply; → applies, × cancels.
 *
 * Presentational only: the host owns the buffers + the active field + apply/cancel (it has the PM caret + the
 * scheme-safe normalizer, and inserts the linked title text on apply). Forward-compatible — this two-field
 * GUI is the seed of the #62 params form (URL+Title → a [url:title=…] node); the rep migrates, the form
 * stays. Buttons/fields preventDefault on pointerdown so the editor keeps focus and the keypad stays live.
 */
export type LinkField = 'title' | 'url';

interface LinkEntryBarProps {
  /** The link's visible text (host-owned buffer, fed by the keypad). */
  title: string;
  /** The link's URL (host-owned buffer, fed by the keypad). */
  url: string;
  /** Which field the keypad currently types into. */
  activeField: LinkField;
  /** Tap a field → make it the keypad target. */
  onFocusField: (field: LinkField) => void;
  /** Apply the link (→ button / keypad Enter on the URL field). */
  onSubmit: () => void;
  /** Abandon link entry (× button). */
  onCancel: () => void;
}

function Field({
  field, value, label, active, onFocus,
}: { field: LinkField; value: string; label: string; active: boolean; onFocus: (f: LinkField) => void }) {
  return (
    <span
      className={`link-entry-bar__field${active ? ' link-entry-bar__field--active' : ''}`}
      role="button"
      tabIndex={-1}
      aria-label={label}
      aria-current={active}
      onPointerDown={(e) => { e.preventDefault(); onFocus(field); }}
    >
      {value
        ? <span className="link-entry-bar__value">{value}</span>
        : <span className="link-entry-bar__placeholder">{label}</span>}
      {active && <span className="link-entry-bar__caret" aria-hidden="true" />}
    </span>
  );
}

export function LinkEntryBar({ title, url, activeField, onFocusField, onSubmit, onCancel }: LinkEntryBarProps) {
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
      <Field field="title" value={title} label="Title" active={activeField === 'title'} onFocus={onFocusField} />
      <Field field="url" value={url} label="URL" active={activeField === 'url'} onFocus={onFocusField} />
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
