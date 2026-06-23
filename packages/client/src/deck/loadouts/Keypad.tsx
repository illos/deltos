import { useEffect, useRef, useState } from 'react';
import type { KeyActions } from '../types.js';

/**
 * Keypad — the Deck's keypad: QWERTY letters + the `123` number layer + the `#+=` symbol layer (#69
 * Phase-2a). The "EDITOR LOADOUT" (one loadout; later grows to keypad + format/slash controls).
 * Editor-AGNOSTIC: it owns the UI mechanics (geometry, zero-dead-zone hit cells, shift one-shot + reactive
 * case, accelerating backspace-hold, layer switching) and emits ABSTRACT KeyActions; the host wires those
 * to its editor. No editor types here — every key just calls actions.insert / backspace / enter.
 *
 * Geometry is matched to Jim's iPhone 15 Plus native keyboard (deck.css holds the metrics as vars). Zero
 * dead zones (#349): each key BUTTON is a hit cell that tiles edge-to-edge; the visible key is a smaller
 * .keypad__face centered inside. On the letters layer, labels are reactive to shift (lowercase /
 * UPPERCASE) = the shift feedback; the number/symbol layers insert literally (no shift).
 *
 * LAYER STATE MACHINE: letters --123--> numbers --#+=--> symbols; numbers/symbols --ABC--> letters,
 * symbols --123--> numbers. Returning to letters resets shift to lowercase (one-shot semantics unchanged).
 * Shift applies to LETTERS ONLY (the switch key sits where shift was on the other layers).
 */

interface KeypadProps {
  actions: KeyActions;
}

type Layer = 'letters' | 'numbers' | 'symbols';

// Layout DATA (#69 Phase-2a) — rows transcribed from the native iPhone 15 Plus reference screenshots
// (docs/design/native-keyboard-{numbers,symbols}-iphone15plus.png). Letters are case-reactive; number and
// symbol keys insert the literal character. Rows 1 & 2 are always 10 full-width cells.
const LETTERS_R1 = [...'QWERTYUIOP'];
const LETTERS_R2 = [...'ASDFGHJKL'];
const LETTERS_R3 = [...'ZXCVBNM'];
const NUMBERS_R1 = [...'1234567890'];
const NUMBERS_R2 = ['-', '/', ':', ';', '(', ')', '$', '&', '@', '"'];
const SYMBOLS_R1 = ['[', ']', '{', '}', '#', '%', '^', '*', '+', '='];
const SYMBOLS_R2 = ['_', '\\', '|', '~', '<', '>', '€', '£', '¥', '•'];
// Row-3 middle punctuation — SHARED by the number and symbol layers (wider than letter keys).
const SHARED_PUNCT = ['.', ',', '?', '!', "'"];

// Backspace-hold: an accelerating char-delete that mimics native (cadence speeds up on sustained hold).
const BKSP_HOLD_MS = 380;   // delay before repeat kicks in
const BKSP_START_MS = 200;  // first repeat interval
const BKSP_MIN_MS = 55;     // fastest cadence
const BKSP_ACCEL = 18;      // ms shaved per tick

// 3-STATE SHIFT (§7.3) — native iPhone model exactly:
//   lower → (tap) → oneshot (next letter caps, then back to lower) → (tap) → lower
//   any → (DOUBLE-tap) → locked (caps lock) → (tap) → lower
// The shift key shows all three states distinctly (see deck.css .is-oneshot / .is-locked).
type ShiftState = 'lower' | 'oneshot' | 'locked';
const SHIFT_DOUBLE_TAP_MS = 300; // two shift taps within this = caps lock
const DOUBLE_SPACE_MS = 600;     // two spaces within this (no intervening key) = "→ . " (§7.1)

export function Keypad({ actions }: KeypadProps) {
  const [layer, setLayer] = useState<Layer>('letters');
  const [shift, setShift] = useState<ShiftState>('lower');
  const bkspTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastShiftTapRef = useRef(0); // performance.now() of the previous shift tap (double-tap detection)
  const lastSpaceAtRef = useRef(0);  // performance.now() of the previous space (0 = reset by any other key)

  // §7.3 auto-capitalize: ask the host (PULL) whether the next letter should cap; arm the one-shot if so.
  // Only arms from 'lower' — never overrides a manual one-shot/caps-lock. Called after edits that can open
  // a sentence (space / sentence-space / enter) and once on mount (doc-start capitalization).
  const maybeAutoCap = () => {
    if (actions.shouldAutoCapitalize?.()) setShift((s) => (s === 'lower' ? 'oneshot' : s));
  };
  useEffect(() => {
    if (actions.shouldAutoCapitalize?.()) setShift((s) => (s === 'lower' ? 'oneshot' : s));
  }, [actions]);

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

  const insertLetter = (c: string) => {
    lastSpaceAtRef.current = 0; // a letter breaks any pending double-space run
    const upper = shift === 'oneshot' || shift === 'locked';
    actions.insert(upper ? c : c.toLowerCase());
    if (shift === 'oneshot') setShift('lower'); // one-shot consumed; caps-lock persists
  };
  // Literal char insert (number/symbol/punct keys) — also breaks the double-space run.
  const insertText = (ch: string) => { lastSpaceAtRef.current = 0; actions.insert(ch); };
  // §7.1 — space, with double-space → ". ". A rapid second space (no intervening key) calls the host's
  // sentenceSpace intent; otherwise a plain space. Either way, re-check auto-cap (a new sentence may open).
  const onSpace = () => {
    const now = performance.now();
    if (actions.sentenceSpace && lastSpaceAtRef.current !== 0 && now - lastSpaceAtRef.current < DOUBLE_SPACE_MS) {
      actions.sentenceSpace();
      lastSpaceAtRef.current = 0; // consumed — a third space starts a fresh run
    } else {
      actions.insert(' ');
      lastSpaceAtRef.current = now;
    }
    maybeAutoCap();
  };
  const onEnter = () => { lastSpaceAtRef.current = 0; actions.enter(); maybeAutoCap(); };
  // Shift tap, native model: from caps-lock ANY tap → lower (checked first, so a quick unlock tap is never
  // mis-read as a double-tap). Otherwise two taps within the window = caps lock; a lone tap toggles
  // oneshot/lower. Mirrors native exactly.
  const onShiftTap = () => {
    const now = performance.now();
    const sinceLast = now - lastShiftTapRef.current;
    lastShiftTapRef.current = now;
    setShift((s) => {
      if (s === 'locked') return 'lower';
      if (sinceLast < SHIFT_DOUBLE_TAP_MS) return 'locked';
      return s === 'lower' ? 'oneshot' : 'lower';
    });
  };
  // Switch layers. Going back to letters resets shift to lowercase (one-shot/lock don't span layers).
  const goLayer = (l: Layer) => { if (l === 'letters') setShift('lower'); setLayer(l); };

  // ── shared key builders ─────────────────────────────────────────────────────
  const deleteKey = (
    <button
      type="button"
      className="keypad__key keypad__key--fn keypad__key--delete"
      aria-label="Backspace"
      onPointerDown={press(startBackspace)}
      onPointerUp={stopBackspace}
      onPointerLeave={stopBackspace}
      onPointerCancel={stopBackspace}
    ><span className="keypad__face">⌫</span></button>
  );
  // A literal-insert key (number / symbol layers — no shift). keypad__key--char gets the press key-pop.
  const litKey = (ch: string) => (
    <button key={ch} type="button" className="keypad__key keypad__key--char" aria-label={ch} onPointerDown={press(() => insertText(ch))}>
      <span className="keypad__pop" aria-hidden="true">{ch}</span>
      <span className="keypad__face">{ch}</span>
    </button>
  );
  // Row-3 punctuation key — wider than a letter key (fills the span between the two fn keys).
  const punctKey = (ch: string) => (
    <button key={ch} type="button" className="keypad__key keypad__key--char keypad__key--punct" aria-label={ch} onPointerDown={press(() => insertText(ch))}>
      <span className="keypad__pop" aria-hidden="true">{ch}</span>
      <span className="keypad__face">{ch}</span>
    </button>
  );
  // Row-3 layer-switch key (#+= / 123) — sits where shift was, fn-width.
  const switchKey = (lbl: string, target: Layer, aria: string) => (
    <button type="button" className="keypad__key keypad__key--fn keypad__key--switch" aria-label={aria} onPointerDown={press(() => goLayer(target))}><span className="keypad__face">{lbl}</span></button>
  );
  // Row-4 mode key (ABC / 123) — wide, native row-4 geometry (matches return).
  const modeKey = (lbl: string, target: Layer, aria: string) => (
    <button type="button" className="keypad__key keypad__key--fn keypad__key--mode" aria-label={aria} onPointerDown={press(() => goLayer(target))}><span className="keypad__face">{lbl}</span></button>
  );
  const spaceKey = (
    <button type="button" className="keypad__key keypad__key--space" aria-label="Space" onPointerDown={press(onSpace)}><span className="keypad__face">space</span></button>
  );
  const returnKey = (
    <button type="button" className="keypad__key keypad__key--fn keypad__key--return" aria-label="Return" onPointerDown={press(onEnter)}><span className="keypad__face">⏎</span></button>
  );

  // ── letters (QWERTY) layer ──────────────────────────────────────────────────
  if (layer === 'letters') {
    // Visible key case is reactive to shift (the feedback): UPPERCASE when armed (oneshot/locked), else lower.
    const upper = shift === 'oneshot' || shift === 'locked';
    const label = (c: string) => (upper ? c : c.toLowerCase());
    const letterKey = (c: string) => (
      <button key={c} type="button" className="keypad__key keypad__key--char" aria-label={c} onPointerDown={press(() => insertLetter(c))}>
        <span className="keypad__pop" aria-hidden="true">{label(c)}</span>
        <span className="keypad__face">{label(c)}</span>
      </button>
    );
    // Shift key: ⇪ (caps lock) when locked, ⇧ otherwise; is-oneshot / is-locked drive the 3 distinct visuals.
    const shiftClass = shift === 'oneshot' ? ' is-oneshot' : shift === 'locked' ? ' is-locked' : '';
    return (
      <div className="keypad" role="group" aria-label="Keyboard">
        <div className="keypad__row">{LETTERS_R1.map(letterKey)}</div>
        <div className="keypad__row keypad__row--r2">{LETTERS_R2.map(letterKey)}</div>
        {/* Row 3 is flat — shift, the 7 letters, delete all tile edge-to-edge directly. */}
        <div className="keypad__row keypad__row--r3">
          <button
            type="button"
            className={`keypad__key keypad__key--fn keypad__key--shift${shiftClass}`}
            aria-label={shift === 'locked' ? 'Caps lock' : 'Shift'}
            aria-pressed={shift !== 'lower'}
            onPointerDown={press(onShiftTap)}
          ><span className="keypad__face">{shift === 'locked' ? '⇪' : '⇧'}</span></button>
          {LETTERS_R3.map(letterKey)}
          {deleteKey}
        </div>
        <div className="keypad__row keypad__row--r4">
          {modeKey('123', 'numbers', 'Numbers and symbols')}
          {spaceKey}
          {returnKey}
        </div>
      </div>
    );
  }

  // ── number & symbol layers (share structure; rows 1-2 + the row-3 switch differ) ─────────────────
  const r1 = layer === 'numbers' ? NUMBERS_R1 : SYMBOLS_R1;
  const r2 = layer === 'numbers' ? NUMBERS_R2 : SYMBOLS_R2;
  const r3Switch = layer === 'numbers'
    ? switchKey('#+=', 'symbols', 'Symbols')
    : switchKey('123', 'numbers', 'Numbers');
  return (
    <div className="keypad" role="group" aria-label="Keyboard">
      <div className="keypad__row">{r1.map(litKey)}</div>
      <div className="keypad__row">{r2.map(litKey)}</div>
      <div className="keypad__row keypad__row--r3">
        {r3Switch}
        {SHARED_PUNCT.map(punctKey)}
        {deleteKey}
      </div>
      <div className="keypad__row keypad__row--r4">
        {modeKey('ABC', 'letters', 'Letters')}
        {spaceKey}
        {returnKey}
      </div>
    </div>
  );
}
