import { useRef, useState } from 'react';
import type { KeyActions } from '../types.js';

/**
 * Keypad — the Deck's QWERTY keypad: the "EDITOR LOADOUT" (one loadout; later grows to keypad +
 * format/slash controls). Editor-AGNOSTIC: it owns the UI
 * mechanics (geometry, zero-dead-zone hit cells, shift one-shot + reactive case, accelerating
 * backspace-hold) and emits ABSTRACT KeyActions; the host wires those to its editor. No editor types here.
 *
 * Geometry is matched to Jim's iPhone 15 Plus native keyboard (deck.css holds the metrics as vars). Zero
 * dead zones (#349): each key BUTTON is a hit cell that tiles edge-to-edge; the visible key is a smaller
 * .keypad__face centered inside. Labels are reactive to shift (lowercase / UPPERCASE) = the shift feedback.
 */

interface KeypadProps {
  actions: KeyActions;
}

const ROW1 = [...'QWERTYUIOP'];
const ROW2 = [...'ASDFGHJKL'];
const ROW3 = [...'ZXCVBNM'];

// Backspace-hold: an accelerating char-delete that mimics native (cadence speeds up on sustained hold).
const BKSP_HOLD_MS = 380;   // delay before repeat kicks in
const BKSP_START_MS = 200;  // first repeat interval
const BKSP_MIN_MS = 55;     // fastest cadence
const BKSP_ACCEL = 18;      // ms shaved per tick

export function Keypad({ actions }: KeypadProps) {
  const [shifted, setShifted] = useState(false);
  const bkspTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const insertChar = (display: string) => {
    actions.insert(shifted ? display : display.toLowerCase());
    if (shifted) setShifted(false); // shift is one-shot
  };

  const startBackspace = () => {
    actions.backspace(); // immediate first delete on press
    let delay = BKSP_START_MS;
    const tick = () => {
      actions.backspace();
      delay = Math.max(BKSP_MIN_MS, delay - BKSP_ACCEL); // accelerate
      bkspTimer.current = setTimeout(tick, delay);
    };
    bkspTimer.current = setTimeout(tick, BKSP_HOLD_MS);
  };
  const stopBackspace = () => {
    if (bkspTimer.current) { clearTimeout(bkspTimer.current); bkspTimer.current = null; }
  };

  // pointerdown + preventDefault on every key so focus (and the caret) never leaves the host editor.
  const press = (handler: () => void) => (e: React.PointerEvent) => { e.preventDefault(); handler(); };
  // Visible key case is reactive to shift (= the shift feedback): UPPERCASE when armed, lowercase otherwise.
  const label = (c: string) => (shifted ? c : c.toLowerCase());

  return (
    // Zero dead zones (#349): each key button is a hit CELL that tiles edge-to-edge; the visible key is a
    // smaller .keypad__face centered inside at the matched geometry.
    <div className="keypad" role="group" aria-label="Keyboard">
      <div className="keypad__row">
        {ROW1.map((c) => (
          <button key={c} type="button" className="keypad__key" aria-label={c} onPointerDown={press(() => insertChar(c))}><span className="keypad__face">{label(c)}</span></button>
        ))}
      </div>
      <div className="keypad__row keypad__row--r2">
        {ROW2.map((c) => (
          <button key={c} type="button" className="keypad__key" aria-label={c} onPointerDown={press(() => insertChar(c))}><span className="keypad__face">{label(c)}</span></button>
        ))}
      </div>
      {/* Row 3 is flat — shift, the 7 letters, delete all tile edge-to-edge directly (a nested wrapper
          dropped 'M' after the hit-cell refactor and isn't needed now that cells tile). */}
      <div className="keypad__row keypad__row--r3">
        <button
          type="button"
          className={`keypad__key keypad__key--fn keypad__key--shift${shifted ? ' is-active' : ''}`}
          aria-label="Shift" aria-pressed={shifted}
          onPointerDown={press(() => setShifted((s) => !s))}
        ><span className="keypad__face">⇧</span></button>
        {ROW3.map((c) => (
          <button key={c} type="button" className="keypad__key" aria-label={c} onPointerDown={press(() => insertChar(c))}><span className="keypad__face">{label(c)}</span></button>
        ))}
        <button
          type="button"
          className="keypad__key keypad__key--fn keypad__key--delete"
          aria-label="Backspace"
          onPointerDown={press(startBackspace)}
          onPointerUp={stopBackspace}
          onPointerLeave={stopBackspace}
          onPointerCancel={stopBackspace}
        ><span className="keypad__face">⌫</span></button>
      </div>
      <div className="keypad__row keypad__row--r4">
        {/* 123 is inert in Phase 1 (number/symbol layer = Phase 2). NOT a disabled <button>: a disabled
            button doesn't fire/bubble pointerdown in some browsers, so it wouldn't preventDefault and a tap
            on it would blur the editor → close the deck. Render it like a live key, greyed + no-op. */}
        <button type="button" className="keypad__key keypad__key--fn keypad__key--mode keypad__key--inert"
          aria-label="Numbers and symbols (Phase 2)" onPointerDown={press(() => { /* Phase 2 */ })}><span className="keypad__face">123</span></button>
        <button type="button" className="keypad__key keypad__key--space" aria-label="Space" onPointerDown={press(() => actions.insert(' '))}><span className="keypad__face">space</span></button>
        <button type="button" className="keypad__key keypad__key--fn keypad__key--return" aria-label="Return" onPointerDown={press(() => actions.enter())}><span className="keypad__face">⏎</span></button>
      </div>
      {/* The keypad-positioning band (#369/#370 → #384): a constant-height layer BELOW the keys that
          restores the ~47pt the native keyboard reserves for its emoji/mic utility row, anchoring the keys
          at the native vertical position. It travels WITH the keypad (layer model §0.6) — a keypad-bearing
          loadout carries it; loadouts without keys (nav) sit flush. Empty now; the editor loadout's group
          selector fills this layer later, and its constant height means the keys never shift when filled. */}
      <div className="keypad__slot" />
    </div>
  );
}
