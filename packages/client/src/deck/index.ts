/**
 * Deck — public API (#69 §0.5). The host imports ONLY from here. The Deck never imports host internals;
 * the host injects everything app/editor-specific via the layout registry + the KeyActions a layout takes.
 * Fenced in src/deck/ for now, promotable to packages/deck/ later by moving the folder.
 *
 * Theming contract: deck.css consumes the HOST's theme tokens as CSS custom properties (--accent, --nav,
 * --list, --ink, --sel, --border, --secondary, --paper, --faint) — it never hardcodes colour, so it
 * inherits the host's active palette by construction. (The label font is pinned to system-ui INSIDE
 * deck.css — a Deck geometry invariant, not a host choice.)
 */
export { Deck } from './Deck.js';
export { Keypad } from './loadouts/Keypad.js';
export type { DeckContext, KeyActions, DeckLoadoutRegistry } from './types.js';
