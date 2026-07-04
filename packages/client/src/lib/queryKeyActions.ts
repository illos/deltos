import type { KeyActions } from '../deck/index.js';

/**
 * A lightweight {@link KeyActions} adapter that edits a plain string query — the Deck's KeyActions
 * contract, honestly implemented for a search/filter field instead of a ProseMirror document (contrast
 * editor/deckAdapter.ts, which is PM-specific). The keypad drives insert/backspace/space/return; layer +
 * shift are handled inside the Keypad itself, so this only implements the minimal char-level subset.
 *
 * Functional updates so the returned handle is STABLE (build once with useMemo) and never captures a stale
 * query. The caret is implicitly the end of the string (no caret model — a filter field doesn't need one),
 * so the optional caret/trackpad + sentence-space + auto-capitalize hooks are deliberately omitted: the
 * Keypad falls back to a plain space, no auto-cap, and an inert space-trackpad — the right feel for search.
 *
 * `enter` is a NO-OP: results are already live as you type, and — critically — return must NOT navigate
 * away from the in-place field (Enter dismissing/committing would fight the "filter the list here" model).
 */
export function buildQueryKeyActions(
  setQuery: (updater: (q: string) => string) => void,
): KeyActions {
  return {
    insert: (text) => setQuery((q) => q + text),
    backspace: () => setQuery((q) => q.slice(0, -1)),
    enter: () => { /* no-op — live filter field; return must not navigate or commit */ },
  };
}
