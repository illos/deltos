import type { ReactNode } from 'react';

/**
 * Deck core types — editor- and app-agnostic (the Deck NEVER imports host internals; #69 §0.5).
 * Vocabulary (locked, Jim): DECK = the surface; LOADOUT = a named set of controls the Deck shows at a
 * given time (it displays exactly ONE active loadout); CONTEXT = the derived situation (selection/device)
 * that SELECTS the active loadout. The keypad is just one loadout (the "editor loadout"). Built for
 * eventual extraction into a standalone framework, so nothing PM/deltos-specific lives here.
 */

/** Opaque context key — the HOST computes it (e.g. from its editor's selection); the Deck never inspects it. */
export type DeckContext = string;

/**
 * Abstract key actions a keypad emits. The HOST wires these to its editor (PM transactions in deltos) —
 * no editor types ever leak into Deck core. Expected to GROW (layer-switch, cursor-move via space-hold,
 * etc.); keep every addition editor-agnostic.
 */
export interface KeyActions {
  insert(text: string): void;
  backspace(): void;
  enter(): void;
  /**
   * Double-space → sentence punctuation (§7.1). The keypad calls this on a detected rapid second space
   * INSTEAD of inserting a plain space; the host decides whether the preceding context qualifies (a letter
   * /digit then the just-typed space → replace that space with ". "), else falls back to a normal space.
   * The skip-after-punctuation rule lives host-side because it depends on the preceding text (editor state).
   * Optional: a host that doesn't implement it makes the keypad fall back to inserting a plain space.
   */
  sentenceSpace?(): void;
  /**
   * Auto-capitalize query (§7.3). The host computes — from its editor's caret context (doc/line start, or
   * after ". " / "! " / "? ") — whether the NEXT letter should be capitalized; the keypad arms its one-shot
   * shift when true. PULL, not push: the keypad calls this after the edits it emits (and on mount), so the
   * Deck stays generic ("the host can tell me to arm") with no editor types and no selection subscription.
   * Optional: absent → no auto-capitalization.
   */
  shouldAutoCapitalize?(): boolean;
  /**
   * Relative caret move (§7.4 space-trackpad). The keypad, in trackpad mode, emits proportional 2D step
   * intents from finger deltas (dx = chars left/right, dy = lines up/down); the host maps them to its
   * editor's selection. Editor-agnostic — the keypad knows "directional steps," never editor positions.
   * Optional: absent → trackpad mode is unavailable (the long-press gesture is a no-op).
   */
  moveCaret?(dx: number, dy: number): void;
}

/** Context → the loadout node to render. The host builds + injects this, closing over its own deps. */
export type DeckLoadoutRegistry = Record<DeckContext, ReactNode>;
