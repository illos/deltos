import type { DeckContext, DeckLoadoutRegistry } from './types.js';
import './deck.css';

interface DeckProps {
  /** The active context (the host derives it). The Deck shows the loadout registered for it. */
  context: DeckContext;
  /** Context → loadout node, injected by the host (no global registry in core — prop-injection keeps the
   *  boundary clean and is forward-compatible with a plugin-composed registry). */
  loadouts: DeckLoadoutRegistry;
}

/**
 * The Deck — an adaptive control surface that owns the bottom slot and shows the LOADOUT registered for the
 * active context (or nothing if none — e.g. a context that should hide the surface). Editor- and
 * app-agnostic (#69 §0.5): it knows only "context → loadout". The backplane swallow (preventDefault on the
 * whole surface) guarantees a tap anywhere in the Deck — keys, gaps, padding — never steals focus from the
 * host's editor; the host's key actions handle focus.
 */
export function Deck({ context, loadouts }: DeckProps) {
  const loadout = loadouts[context];
  if (!loadout) return null;
  return (
    <div
      className="deck"
      data-deck-context={context}
      role="group"
      aria-label="Controls"
      onPointerDown={(e) => e.preventDefault()}
    >
      {loadout}
      {/* The reserved bottom SLOT — a constant-height band below the loadout. ALWAYS present whenever the
          Deck is shown, so the loadout's controls sit at a fixed vertical position: a loadout MAY fill the
          slot (the editor loadout's group selector, slice C) or leave it empty, but the height never
          changes → the keys NEVER shift between states. Empty, it restores the band the native iOS keyboard
          reserves for its emoji/mic utility row, matching the keypad's vertical geometry (#369/#370). */}
      <div className="deck__slot" />
    </div>
  );
}
