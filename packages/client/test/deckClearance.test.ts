/**
 * #97 — the Deck selection-clearance decision (pure). The DOM wiring (selectionchange → coordsAtPos →
 * scroll) + the ResizeObserver-published --deck-h are feel-tuned on-device (Jim's gate); this covers the
 * geometry: scroll down only when the selection sits below the Deck, by exactly enough to clear it.
 */
import { describe, it, expect } from 'vitest';
import { deckClearanceScroll, DECK_CLEARANCE_MARGIN_PX } from '../src/lib/deckClearance.js';

describe('deckClearanceScroll', () => {
  // viewport 800, deck 300, margin 16 → safeBottom = 484.
  it('returns 0 when the selection is already above the Deck (no scroll)', () => {
    expect(deckClearanceScroll(400, 800, 300, 16)).toBe(0);
  });

  it('returns the exact delta to lift a below-Deck selection clear', () => {
    expect(deckClearanceScroll(600, 800, 300, 16)).toBe(116); // 600 - 484
  });

  it('boundary: a selection exactly at safeBottom does not scroll', () => {
    expect(deckClearanceScroll(484, 800, 300, 16)).toBe(0);
  });

  it('a TALLER Deck needs more clearance for the same selection', () => {
    const small = deckClearanceScroll(600, 800, 200, 16); // safe 584 → 16
    const tall = deckClearanceScroll(600, 800, 360, 16);  // safe 424 → 176
    expect(tall).toBeGreaterThan(small);
  });

  it('a zero-height Deck (not shown) only clears the margin', () => {
    expect(deckClearanceScroll(790, 800, 0, 16)).toBe(6); // safe 784 → 6
  });

  it('defaults the margin to DECK_CLEARANCE_MARGIN_PX when omitted', () => {
    expect(deckClearanceScroll(600, 800, 300)).toBe(deckClearanceScroll(600, 800, 300, DECK_CLEARANCE_MARGIN_PX));
  });
});
