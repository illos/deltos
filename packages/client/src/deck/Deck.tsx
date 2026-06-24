import { useLayoutEffect, useRef } from 'react';
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
  const ref = useRef<HTMLDivElement>(null);
  // #97: publish the REAL rendered Deck height as a CSS var (--deck-h on :root) so the editor's clearance
  // (padding/scroll-padding + the JS selection-clearance) reads the true height — varies by loadout / layer
  // (keypad shown vs collapsed) / device / orientation — instead of a hardcoded 311px/72px. ResizeObserver
  // keeps it live; 0 when the Deck isn't shown. Runs every render so a loadout swap re-evaluates the ref.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!el) { root.style.setProperty('--deck-h', '0px'); return; }
    const publish = () => root.style.setProperty('--deck-h', `${Math.round(el.getBoundingClientRect().height)}px`);
    publish();
    // ResizeObserver keeps it live across loadout/layer changes; absent in SSR/jsdom → the one-shot publish
    // above still seeds the var.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); root.style.setProperty('--deck-h', '0px'); };
  });
  if (!loadout) return null;
  return (
    <div
      ref={ref}
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
