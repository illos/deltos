/**
 * #97 Deck selection-clearance geometry. iOS native long-press selection-scroll ignores
 * scroll-padding-bottom, so a word selected near the bottom of the note lands BEHIND the Deck. We scroll it
 * back above explicitly; this module holds the pure (testable) decision + the scroll-container lookup.
 */

/** Margin above the Deck so a cleared selection isn't flush against the keyboard fold. */
export const DECK_CLEARANCE_MARGIN_PX = 16;

/**
 * How far (px) the note's scroll container must scroll DOWN so the selection's bottom edge clears the Deck,
 * or 0 if it's already above. safeBottom = the viewport bottom − the real Deck height − a margin; anything
 * below that is hidden under the Deck. Pure — all geometry is passed in.
 */
export function deckClearanceScroll(
  selectionBottom: number,
  viewportBottom: number,
  deckHeight: number,
  margin: number = DECK_CLEARANCE_MARGIN_PX,
): number {
  const safeBottom = viewportBottom - deckHeight - margin;
  return selectionBottom > safeBottom ? selectionBottom - safeBottom : 0;
}

/**
 * The nearest SCROLLABLE ancestor of `el` (the note's actual scroll container — which varies by shell), so
 * the clearance scroll targets the element that really scrolls (#97 part C) rather than a no-op node. Falls
 * back to the document scroller.
 */
export function findScrollParent(el: HTMLElement | null): HTMLElement {
  let node: HTMLElement | null = el?.parentElement ?? null;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}
