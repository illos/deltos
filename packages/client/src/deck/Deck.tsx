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
      {/* The loadout places its own layers (layer model §0.6) — e.g. the keypad carries its positioning
          band, the nav loadout sits flush. The Deck core just hosts whichever loadout the context selects. */}
      {loadout}
    </div>
  );
}
