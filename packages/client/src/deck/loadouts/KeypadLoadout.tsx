import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { KeyActions } from '../types.js';
import { Keypad } from './Keypad.js';
import { ChevronUp, ChevronDown, Lock } from '../../icons/index.js';

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

// Long-press → LOCK threshold. Matches the keypad's own hold-to-enter-a-mode convention (SPACE_LONG_PRESS_MS
// = 300ms, hold spacebar → trackpad mode) so every "hold decides a mode" gesture in the Deck feels the same.
const LONG_PRESS_MS = 300;

// Rendered px for the direction/lock indicator (~ the old 15px chevron weight). All three indicator icons
// render at this exact size and share IconBase's 24×24 viewBox → identical box → constant button width.
const IND_PX = 16;

/**
 * Keyboard glyph for the show/hide toggle — the native iOS dismiss-keyboard affordance. Kept as a
 * DECK-CORE-LOCAL inline SVG: there's no Keyboard glyph in the host icon set to reuse. Matches the deltos
 * fine-line look by convention (24×24, currentColor stroke, 1.5 round caps/joins). currentColor → it inherits
 * the button's themed colour. (The direction/lock INDICATOR beside it uses the shared icon set — ChevronUp/
 * ChevronDown/Lock, cut to identical geometry so the button never resizes across states — per Jim's directive;
 * that is the one place a loadout reaches into ../../icons, a deliberate exception to the extraction boundary.)
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
  //
  // TAP-WHILE-LOCKED semantics: a short tap ALWAYS toggles shown/hidden and LEAVES the lock engaged — it
  // does NOT unlock. Rationale (least-surprising + matches the host's design comment "tap drives; long-press
  // decides if the keyboard may drive itself"): the lock governs only the AUTO show/hide; manual taps are
  // still the user's direct control and shouldn't secretly also flip the mode. Unlock lives on long-press.
  //
  // `pressing` drives the CSS "arming" cue (a subtle scale/fill that charges over LONG_PRESS_MS and snaps
  // back the instant the lock fires — the visual feedback AT threshold). Cleared on release or on fire.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longFired = useRef(false);
  const [pressing, setPressing] = useState(false);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    longFired.current = false;
    setPressing(true);
    timer.current = setTimeout(() => {
      longFired.current = true;
      setPressing(false); // snap back at threshold = the "locked" confirmation pop
      onToggleLock();
    }, LONG_PRESS_MS);
  };
  const onUp = (e: React.PointerEvent) => {
    e.preventDefault();
    clear();
    setPressing(false);
    // The press that became a long-press already fired the lock; do NOT also toggle on release.
    if (!longFired.current) onToggleKeypad();
  };
  const onCancel = () => { clear(); setPressing(false); };

  return (
    <div className="keypad-loadout">
      {/* Top-slot layer — an OUT-OF-FLOW overlay ABOVE the keys (#69 §5.1). One occupant at a time
          (formatting submenu / spell suggestions / voice waveform), chosen by the host; null = empty.
          NO-JUMP: it's absolutely positioned (see deck.css) so it does NOT grow the Deck's measured box —
          --deck-h stays constant, so the editor's bottom padding never reflows when it shows/hides (the
          Deck is position:fixed; a transient bar must not feed the in-flow editor layout). It visually
          overlays the bottom of the note instead of pushing content. */}
      {topSlot && <div className="keypad-loadout__top-slot">{topSlot}</div>}
      {keypadShown && <Keypad actions={actions} />}
      {/* Persistent base region — the control home below the keys; present in both sub-states. */}
      <div className="keypad-loadout__base">
        {baseExtra}
        <button
          type="button"
          className={`deck-kbd-toggle${pressing ? ' deck-kbd-toggle--arming' : ''}${locked ? ' deck-kbd-toggle--locked' : ''}`}
          aria-label={`${keypadShown ? 'Hide' : 'Show'} keyboard${locked ? ' (locked)' : ''}`}
          aria-pressed={keypadShown}
          data-locked={locked || undefined}
          onPointerDown={onDown}
          onPointerUp={onUp}
          onPointerLeave={onCancel}
          onPointerCancel={onCancel}
        >
          <KeyboardGlyph />
          {/* Fixed-geometry indicator beside the keyboard glyph — ALWAYS exactly one icon, all three rendered
              at the SAME size / identical 24-grid box so the button never resizes: Lock when pinned (auto
              suspended), else a direction chevron (down = tap-to-hide, up = tap-to-show; also signals auto
              MAY move the keyboard). Each icon carries a data-ind for the render test to assert geometry. */}
          <span className="deck-kbd-toggle__ind">
            {locked ? (
              <Lock size={IND_PX} className="deck-kbd-toggle__ind-icon" data-ind="lock" />
            ) : keypadShown ? (
              <ChevronDown size={IND_PX} className="deck-kbd-toggle__ind-icon" data-ind="down" />
            ) : (
              <ChevronUp size={IND_PX} className="deck-kbd-toggle__ind-icon" data-ind="up" />
            )}
          </span>
        </button>
      </div>
    </div>
  );
}
