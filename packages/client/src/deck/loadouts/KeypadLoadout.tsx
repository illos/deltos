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
}

export function KeypadLoadout({
  actions,
  keypadShown,
  locked,
  onToggleKeypad,
  onToggleLock,
  baseExtra,
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
      {keypadShown && <Keypad actions={actions} />}
      {/* Persistent base region — the control home below the keys; present in both sub-states. */}
      <div className="keypad-loadout__base">
        {baseExtra}
        <button
          type="button"
          className={`deck-kbd-toggle${locked ? ' is-locked' : ''}`}
          aria-label={`${keypadShown ? 'Hide' : 'Show'} keyboard${locked ? ' (locked)' : ''}`}
          aria-pressed={keypadShown}
          onPointerDown={onDown}
          onPointerUp={onUp}
          onPointerLeave={clear}
          onPointerCancel={clear}
        >
          <span className="deck-kbd-toggle__chevron">{keypadShown ? '⌄' : '⌃'}</span>
        </button>
      </div>
    </div>
  );
}
