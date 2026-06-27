import { useRef } from 'react';
import type { ReactNode } from 'react';
import type { KeyActions } from '../types.js';
import { Keypad } from './Keypad.js';

/**
 * KeypadLoadout — a loadout built around the keypad, as a two-layer stack (layer model §0.6):
 *
 *   ┌ collapsible KEYPAD layer ┐   ← shown/hidden independently; when hidden, the note reclaims its height
 *   └ persistent BASE region   ┘   ← always present (carries the show/hide toggle; the control home below
 *                                     the keys). Its constant height puts the keys at the native vertical
 *                                     position when shown (the ~47pt band native reserves for its emoji/mic
 *                                     row, #369/#384) AND remains as a slim bar when the keypad is collapsed.
 *
 * CONTROLLED: the host owns `keypadShown` / `locked` (it needs them for auto-show on editor focus and for
 * caret clearance) and passes the toggle callbacks. Editor-AGNOSTIC — abstract KeyActions only, no editor
 * types. The show/hide of a layer is generic Deck behavior (§0.6), so the toggle button is core chrome;
 * key-less loadouts (e.g. nav) don't use this composition, so they carry no base region and sit flush.
 *
 * `baseExtra` is a forward seam: the editor loadout v1 injects host controls (the group selector,
 * Undo/Redo) alongside the toggle in the base region. Unused for now.
 */

const LONG_PRESS_MS = 450;

/**
 * Keyboard glyph for the show/hide toggle — the native iOS dismiss-keyboard affordance. DECK-CORE-LOCAL
 * inline SVG by design: the Deck must not import the host's icon set (extraction boundary). Matches the
 * deltos fine-line look by convention (24×24, currentColor stroke, 1.5 round caps/joins) so it sits with
 * the host's icons, without coupling to them. currentColor → it inherits the button's themed colour.
 */
function KeyboardGlyph() {
  return (
    <svg
      className="deck-kbd-toggle__icon"
      width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 13.5h.01M18 13.5h.01" />
      <path d="M9.5 13.5h5" />
    </svg>
  );
}

interface KeypadLoadoutProps {
  actions: KeyActions;
  /** Is the keypad layer visible. Host-owned (drives auto-show + caret clearance). */
  keypadShown: boolean;
  /** Is auto-show/hide suspended (pinned). Host-owned. */
  locked: boolean;
  /** Tap the toggle — flip the keypad shown/hidden. */
  onToggleKeypad: () => void;
  /** Long-press the toggle — flip the lock (suspend/resume auto). */
  onToggleLock: () => void;
  /** Host-injected base-region controls (editor loadout v1: group selector / Undo·Redo). */
  baseExtra?: ReactNode;
  /** The TOP-SLOT layer ABOVE the keys (#69 §5.1) — a context-driven surface with ONE mutually-exclusive
   *  occupant at a time: the formatting submenu, the spellcheck suggestion bar, or (later) the voice
   *  waveform. The host computes the occupant. Grows the Deck upward into the note — the keys never move.
   *  Null = empty (keys + base region at rest). */
  topSlot?: ReactNode;
}

export function KeypadLoadout({
  actions,
  keypadShown,
  locked,
  onToggleKeypad,
  onToggleLock,
  baseExtra,
  topSlot,
}: KeypadLoadoutProps) {
  // Tap vs long-press on one button: a timer started on pointerdown fires the lock; a pointerup before it
  // is a tap (toggle). preventDefault keeps the host editor focused (the Deck also swallows at the
  // container, but the button needs its own handlers for the timer anyway).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longFired = useRef(false);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    longFired.current = false;
    timer.current = setTimeout(() => { longFired.current = true; onToggleLock(); }, LONG_PRESS_MS);
  };
  const onUp = (e: React.PointerEvent) => {
    e.preventDefault();
    clear();
    if (!longFired.current) onToggleKeypad();
  };

  return (
    <div className="keypad-loadout">
      {/* Top-slot layer — ABOVE the keys (grows the Deck upward; keys never move). One occupant at a time
          (formatting submenu / spell suggestions / voice waveform), chosen by the host. Null = empty. */}
      {topSlot}
      {keypadShown && <Keypad actions={actions} />}
      {/* Persistent base region — the control home below the keys; present in both sub-states. */}
      <div className="keypad-loadout__base">
        {baseExtra}
        <button
          type="button"
          className="deck-kbd-toggle"
          aria-label={`${keypadShown ? 'Hide' : 'Show'} keyboard${locked ? ' (locked)' : ''}`}
          aria-pressed={keypadShown}
          onPointerDown={onDown}
          onPointerUp={onUp}
          onPointerLeave={clear}
          onPointerCancel={clear}
        >
          <KeyboardGlyph />
          {/* The chevron shows direction (⌄ hide / ⌃ show) AND is the lock indicator: present = auto may
              move the keyboard; ABSENT (locked) = pinned, won't move on its own. Long-press toggles it. */}
          {!locked && <span className="deck-kbd-toggle__chevron">{keypadShown ? '⌄' : '⌃'}</span>}
        </button>
      </div>
    </div>
  );
}
