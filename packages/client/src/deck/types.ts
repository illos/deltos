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
}

/** Context → the loadout node to render. The host builds + injects this, closing over its own deps. */
export type DeckLoadoutRegistry = Record<DeckContext, ReactNode>;
