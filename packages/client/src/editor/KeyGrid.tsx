import { useRef, useState } from 'react';
import type { Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { baseKeymap, deleteSelection, joinBackward } from 'prosemirror-commands';

/**
 * KeyGrid — the keyboard footprint's layout for the DEFAULT caret-in-text context (#69 Phase 1). This is
 * ONE registered layout, not a permanent base: KeyboardSurface swaps it out (or hides it) per context.
 * Geometry-matched to Jim's iPhone 15 Plus native keyboard (docs/design/native-keyboard-iphone15plus.png
 * = source of truth; metrics in styles.css as vars so the overlay diff tunes one place).
 *
 * Every editing key is explicit — once inputmode=none suppresses the native keyboard, nothing comes free
 * from the OS (probe #68): letters, shift (one-shot), space, backspace (own char-delete + hold accel),
 * return each dispatch a ProseMirror transaction. Keys fire on pointerdown + preventDefault so the
 * editor never blurs.
 */

interface KeyGridProps {
  /** The editor view to type into. Null while the view (re)mounts — keys no-op safely. */
  view: EditorView | null;
}

const ROW1 = [...'QWERTYUIOP'];
const ROW2 = [...'ASDFGHJKL'];
const ROW3 = [...'ZXCVBNM'];

// Backspace-hold: an accelerating char-delete that mimics native (cadence speeds up on sustained hold).
const BKSP_HOLD_MS = 380;   // delay before repeat kicks in
const BKSP_START_MS = 200;  // first repeat interval
const BKSP_MIN_MS = 55;     // fastest cadence
const BKSP_ACCEL = 18;      // ms shaved per tick

export function KeyGrid({ view }: KeyGridProps) {
  const [shifted, setShifted] = useState(false);
  const bkspTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dispatch = (fn: (v: EditorView) => void) => {
    if (!view) return;
    fn(view);
    view.focus();
  };

  const insertChar = (display: string) => dispatch((v) => {
    v.dispatch(v.state.tr.insertText(shifted ? display : display.toLowerCase()));
    if (shifted) setShifted(false); // shift is one-shot
  });
  const insertSpace = () => dispatch((v) => v.dispatch(v.state.tr.insertText(' ')));
  const runReturn = () => dispatch((v) => (baseKeymap['Enter'] as Command)(v.state, v.dispatch, v));

  // Own the char-delete: baseKeymap.Backspace only joins at block boundaries (the native keyboard does
  // mid-text delete), and we suppressed the native keyboard — so the custom keyboard does it itself.
  const doBackspaceOnce = (v: EditorView) => {
    const { selection } = v.state;
    if (!selection.empty) { deleteSelection(v.state, v.dispatch); return; }
    if (selection.$from.parentOffset > 0) { v.dispatch(v.state.tr.delete(selection.from - 1, selection.from)); return; }
    joinBackward(v.state, v.dispatch, v); // at block start → merge with the previous block
  };
  const startBackspace = () => {
    dispatch(doBackspaceOnce); // immediate first delete on press
    let delay = BKSP_START_MS;
    const tick = () => {
      dispatch(doBackspaceOnce);
      delay = Math.max(BKSP_MIN_MS, delay - BKSP_ACCEL); // accelerate
      bkspTimer.current = setTimeout(tick, delay);
    };
    bkspTimer.current = setTimeout(tick, BKSP_HOLD_MS);
  };
  const stopBackspace = () => {
    if (bkspTimer.current) { clearTimeout(bkspTimer.current); bkspTimer.current = null; }
  };

  // pointerdown + preventDefault on every key so focus (and the caret) never leaves the editor.
  const press = (handler: () => void) => (e: React.PointerEvent) => { e.preventDefault(); handler(); };

  return (
    // Zero dead zones (#349): every key BUTTON is a hit CELL that tiles edge-to-edge (no inter-key gap),
    // and the visible key is a smaller .kb__face centered inside at the overlay-matched geometry. A tap
    // that lands in what was a gap now hits the nearest key's cell. Visuals unchanged; only the invisible
    // hit area grew to fill the gaps.
    <div className="kb__grid" role="group" aria-label="Keyboard">
      <div className="kb__row">
        {ROW1.map((c) => (
          <button key={c} type="button" className="kb__key" aria-label={c} onPointerDown={press(() => insertChar(c))}><span className="kb__face">{c}</span></button>
        ))}
      </div>
      <div className="kb__row kb__row--r2">
        {ROW2.map((c) => (
          <button key={c} type="button" className="kb__key" aria-label={c} onPointerDown={press(() => insertChar(c))}><span className="kb__face">{c}</span></button>
        ))}
      </div>
      <div className="kb__row kb__row--r3">
        <button
          type="button"
          className={`kb__key kb__key--fn kb__key--shift${shifted ? ' is-active' : ''}`}
          aria-label="Shift" aria-pressed={shifted}
          onPointerDown={press(() => setShifted((s) => !s))}
        ><span className="kb__face">⇧</span></button>
        {/* The 7 letters stay centered between the wider shift/delete (aligned under row 2). */}
        <div className="kb__row-mid">
          {ROW3.map((c) => (
            <button key={c} type="button" className="kb__key" aria-label={c} onPointerDown={press(() => insertChar(c))}><span className="kb__face">{c}</span></button>
          ))}
        </div>
        <button
          type="button"
          className="kb__key kb__key--fn kb__key--delete"
          aria-label="Backspace"
          onPointerDown={press(startBackspace)}
          onPointerUp={stopBackspace}
          onPointerLeave={stopBackspace}
          onPointerCancel={stopBackspace}
        ><span className="kb__face">⌫</span></button>
      </div>
      <div className="kb__row kb__row--r4">
        {/* 123 is inert in Phase 1 (number/symbol layer = Phase 2). NOT a disabled <button>: a disabled
            button doesn't fire/bubble pointerdown in some browsers, so it wouldn't preventDefault and a
            tap on it blurred the editor → closed the keyboard (Jim's repro). Render it like a live key —
            same pointerdown+preventDefault — just greyed + no-op, so it preserves focus exactly like the
            others. */}
        <button type="button" className="kb__key kb__key--fn kb__key--mode kb__key--inert"
          aria-label="Numbers and symbols (Phase 2)" onPointerDown={press(() => { /* Phase 2 */ })}><span className="kb__face">123</span></button>
        <button type="button" className="kb__key kb__key--space" aria-label="Space" onPointerDown={press(insertSpace)}><span className="kb__face">space</span></button>
        <button type="button" className="kb__key kb__key--fn kb__key--return" aria-label="Return" onPointerDown={press(runReturn)}><span className="kb__face">⏎</span></button>
      </div>
    </div>
  );
}
