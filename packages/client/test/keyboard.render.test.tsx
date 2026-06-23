/**
 * Deck — Phase 1. Two concerns, now split along the extraction boundary (#69 §0.5):
 *  - Keypad (the editor LOADOUT, Deck core): functional keys via ABSTRACT KeyActions (no editor types) —
 *    letters (lowercase default + reactive case), shift one-shot, space (stacks), backspace (tap + hold
 *    accel), return; zero-dead-zone hit cells; row 3 has all 7 letters incl M.
 *  - Deck (the surface): shows the loadout registered for the active context; backplane-swallow.
 *  - deriveDeckContext (deltos adapter, PM-specific): selection → context key.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { Schema } from 'prosemirror-model';
import { EditorState, NodeSelection } from 'prosemirror-state';
import { Keypad, Deck } from '../src/deck/index.js';
import type { KeyActions } from '../src/deck/index.js';
import { deriveDeckContext } from '../src/editor/deckAdapter.js';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

// Stub KeyActions — accumulate a text buffer so we can assert the keypad's abstract output without PM.
function mountKeypad() {
  let buffer = '';
  const actions: KeyActions = {
    insert: (t) => { buffer += t; },
    backspace: () => { buffer = buffer.slice(0, -1); },
    enter: () => { buffer += '\n'; },
  };
  render(<Keypad actions={actions} />);
  return { text: () => buffer };
}
const key = (label: string) => document.querySelector(`.keypad__key[aria-label="${label}"]`) as HTMLButtonElement;
const tap = (label: string) => fireEvent.pointerDown(key(label));

describe('Keypad — structure + typing (editor loadout, abstract actions)', () => {
  it('renders the 4 rows + the full key set; row 3 has all 7 letters incl M', () => {
    mountKeypad();
    expect(document.querySelectorAll('.keypad__row').length).toBe(4);
    for (const l of ['Q', 'A', 'Shift', 'Backspace', 'Space', 'Return', 'Z', 'X', 'C', 'V', 'B', 'N', 'M']) {
      expect(key(l), l).not.toBeNull();
    }
  });

  it('every key is a tiling hit CELL with the visible key as a centered .keypad__face (#349)', () => {
    mountKeypad();
    const keys = [...document.querySelectorAll('.keypad__key')];
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) expect(k.querySelector('.keypad__face')).not.toBeNull();
  });

  it('letters insert lowercase by default', () => { const { text } = mountKeypad(); tap('Q'); tap('A'); tap('Z'); expect(text()).toBe('qaz'); });

  it('shift one-shot capitalizes the next letter then releases; labels react to case', () => {
    const { text } = mountKeypad();
    expect(key('Q').querySelector('.keypad__face')!.textContent).toBe('q');
    tapShift();
    expect(key('Q').querySelector('.keypad__face')!.textContent).toBe('Q');
    tap('Q'); tap('W');
    expect(text()).toBe('Qw');
    expect(key('Q').querySelector('.keypad__face')!.textContent).toBe('q'); // one-shot consumed
  });

  it('space stacks; backspace tap deletes one; return inserts a break', () => {
    const { text } = mountKeypad();
    tap('A'); tap('Space'); tap('Space'); tap('B');
    expect(text()).toBe('a  b');
    fireEvent.pointerDown(key('Backspace')); fireEvent.pointerUp(key('Backspace'));
    expect(text()).toBe('a  ');
    tap('Return');
    expect(text()).toBe('a  \n');
  });

  it('backspace hold deletes more than one char (accelerating repeat)', () => {
    vi.useFakeTimers();
    const { text } = mountKeypad();
    tap('A'); tap('B'); tap('C'); tap('D'); tap('E');
    fireEvent.pointerDown(key('Backspace'));
    vi.advanceTimersByTime(380 + 200 + 182);
    fireEvent.pointerUp(key('Backspace'));
    expect(text().length).toBeLessThan(4);
  });

  it('the 123 mode key is a real (non-disabled) button — preserves focus, not a dismisser', () => {
    mountKeypad();
    const mode = document.querySelector('.keypad__key--mode') as HTMLButtonElement;
    expect(mode.disabled).toBe(false); // real <button> → pointerdown preventable → keeps host focus
  });
});

// ── #69 Phase-2a — number (123) & symbol (#+=) layers + the switch state machine ───────────────────────
describe('Keypad — number & symbol layers + layer switching (#69 Phase-2a)', () => {
  it('123 switches letters → numbers; the digit row + number-layer keys appear, QWERTY is gone', () => {
    mountKeypad();
    expect(key('Q')).not.toBeNull(); // letters layer
    tap('Numbers and symbols'); // the 123 mode key
    for (const l of ['1', '2', '0', '-', '@', 'Symbols', 'Letters', 'Backspace', 'Space', 'Return']) {
      expect(key(l), l).not.toBeNull();
    }
    expect(key('Q')).toBeNull(); // letters gone
    expect(document.querySelectorAll('.keypad__row').length).toBe(4); // still 4 rows
  });

  it('#+= switches numbers → symbols; 123 (row 3) returns numbers → symbols-and-back', () => {
    mountKeypad();
    tap('Numbers and symbols'); // → numbers
    tap('Symbols');             // → symbols (the #+= row-3 switch)
    for (const l of ['[', ']', '{', '#', '€', '£', '•', 'Numbers', 'Letters']) {
      expect(key(l), l).not.toBeNull();
    }
    expect(key('1')).toBeNull(); // number row-1 gone
    tap('Numbers'); // symbols → numbers (the 123 row-3 switch)
    expect(key('1')).not.toBeNull();
    expect(key('[')).toBeNull();
  });

  it('ABC returns to letters from both layers and resets shift to lowercase', () => {
    const { text } = mountKeypad();
    tapShift(); // arm uppercase on the letters layer
    tap('Numbers and symbols'); // → numbers (switch key sits where shift was; shift untouched here)
    tap('Letters'); // ABC → back to letters
    expect(key('Q')).not.toBeNull();
    expect(key('Q').querySelector('.keypad__face')!.textContent).toBe('q'); // shift reset on return
    tap('Q');
    expect(text()).toBe('q');
  });

  it('number / symbol / shared-punct keys insert their literal character (no shift)', () => {
    const { text } = mountKeypad();
    tap('Numbers and symbols');
    tap('1'); tap('0'); tap('@'); tap('.'); // digits + a number key + shared punctuation
    tap('Symbols');
    tap('#'); tap('•');
    expect(text()).toBe('10@.#•');
  });
});

describe('Deck — context-driven surface', () => {
  it('shows the loadout for the active context + swallows backplane pointerdown', () => {
    render(<Deck context="text" loadouts={{ text: <div data-testid="lo">keypad</div> }} />);
    const deck = document.querySelector('.deck') as HTMLElement;
    expect(deck).not.toBeNull();
    expect(document.querySelector('[data-testid="lo"]')).not.toBeNull();
    const ev = new Event('pointerdown', { bubbles: true, cancelable: true });
    deck.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
  it('renders NOTHING for a context with no registered loadout (surface hideable)', () => {
    const { container } = render(<Deck context="node:widget" loadouts={{ text: <div /> }} />);
    expect(container.firstChild).toBeNull();
  });
  it('adds NO positioning band of its own — a key-less loadout sits flush (#384)', () => {
    // The base region belongs to the keypad loadout, not the Deck surface: a plain loadout has neither
    // a keypad-loadout base region nor the show/hide toggle.
    render(<Deck context="text" loadouts={{ text: <div data-testid="lo">flush</div> }} />);
    expect(document.querySelector('[data-testid="lo"]')).not.toBeNull();
    expect(document.querySelector('.keypad-loadout__base')).toBeNull();
    expect(document.querySelector('.deck-kbd-toggle')).toBeNull();
  });
});

describe('deriveDeckContext (deltos adapter)', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
      widget: { group: 'block', atom: true, selectable: true, toDOM: () => ['div', { 'data-widget': '' }] },
      text: {},
    },
    marks: {},
  });
  it('TextSelection → "text", NodeSelection → "node:<type>"', () => {
    const base = EditorState.create({ doc: schema.node('doc', null, [schema.node('paragraph'), schema.node('widget')]), schema });
    expect(deriveDeckContext(base)).toBe('text');
    const widgetPos = base.doc.child(0).nodeSize;
    const nodeSel = base.apply(base.tr.setSelection(NodeSelection.create(base.doc, widgetPos)));
    expect(deriveDeckContext(nodeSel)).toBe('node:widget');
  });
});

// ── #69 §7 — 3-state shift + key-pop ───────────────────────────────────────────────────────────────────
const shiftKey = () => document.querySelector('.keypad__key--shift') as HTMLButtonElement;
const shiftFace = () => shiftKey().querySelector('.keypad__face')!.textContent;
const qFace = () => key('Q').querySelector('.keypad__face')!.textContent;
// Tap shift by CLASS (its aria-label flips to "Caps lock" when locked, so an aria-label query would miss).
const tapShift = () => fireEvent.pointerDown(shiftKey());

describe('Keypad — 3-state shift (§7.3)', () => {
  it('lower → tap → one-shot: next letter caps, then releases to lower', () => {
    const { text } = mountKeypad();
    expect(qFace()).toBe('q'); // lower default
    tapShift();
    expect(qFace()).toBe('Q'); // armed (one-shot)
    expect(shiftKey().className).toContain('is-oneshot');
    expect(shiftKey().getAttribute('aria-pressed')).toBe('true');
    tap('Q'); tap('W');
    expect(text()).toBe('Qw'); // only the first letter capitalized
    expect(qFace()).toBe('q'); // released back to lower
  });

  it('one-shot → tap (deliberate, outside the double-tap window) → lower (disarm)', async () => {
    mountKeypad();
    tapShift();
    expect(shiftKey().className).toContain('is-oneshot');
    await new Promise((r) => setTimeout(r, 320)); // exceed the 300ms double-tap window
    tapShift();
    expect(qFace()).toBe('q'); // back to lower
    expect(shiftKey().className).not.toContain('is-oneshot');
  });

  it('double-tap → caps lock: every letter caps + stays locked; glyph ⇪, aria Caps lock', () => {
    const { text } = mountKeypad();
    tapShift(); tapShift(); // two quick taps = caps lock
    expect(shiftKey().className).toContain('is-locked');
    expect(shiftFace()).toBe('⇪');
    expect(shiftKey().getAttribute('aria-label')).toBe('Caps lock');
    tap('A'); tap('B'); tap('C');
    expect(text()).toBe('ABC'); // all caps — lock persists across letters
    expect(qFace()).toBe('Q'); // still showing uppercase
  });

  it('caps lock → tap → lower (even a quick tap unlocks, never re-locks)', () => {
    mountKeypad();
    tapShift(); tapShift(); // lock
    expect(shiftKey().className).toContain('is-locked');
    tapShift(); // quick unlock tap
    expect(shiftKey().className).not.toContain('is-locked');
    expect(qFace()).toBe('q');
  });

  it('switching to the number layer and back resets shift to lower', () => {
    mountKeypad();
    tapShift(); tapShift(); // lock
    tap('Numbers and symbols'); // → numbers
    tap('Letters'); // → back to letters
    expect(shiftKey().className).not.toContain('is-locked');
    expect(qFace()).toBe('q');
  });
});

describe('Keypad — key-pop on press (§7.2)', () => {
  it('character keys carry a key-pop balloon; space/shift/delete do NOT', () => {
    mountKeypad();
    // letter keys are character keys with a pop balloon
    expect(key('Q').className).toContain('keypad__key--char');
    expect(key('Q').querySelector('.keypad__pop')).not.toBeNull();
    // fn / space keys are NOT character keys and have no pop (native doesn't pop them)
    expect(key('Space').className).not.toContain('keypad__key--char');
    expect(key('Space').querySelector('.keypad__pop')).toBeNull();
    expect(shiftKey().querySelector('.keypad__pop')).toBeNull();
    expect(key('Backspace').querySelector('.keypad__pop')).toBeNull();
  });

  it('number/symbol character keys also carry the pop, but the layer-switch fn keys do not', () => {
    mountKeypad();
    tap('Numbers and symbols');
    expect(key('1').className).toContain('keypad__key--char');
    expect(key('1').querySelector('.keypad__pop')).not.toBeNull();
    expect(key('Symbols').className).not.toContain('keypad__key--char'); // #+= switch = fn, no pop
  });
});

// ── #69 §7 increment 2a — double-space→period + auto-capitalize ─────────────────────────────────────────
// A host stub that implements the optional KeyActions intents the same way the deltos adapter does, so the
// keypad's emit-side logic (double-space detection, auto-cap arming) is exercised end-to-end.
function mountWithHost() {
  let buffer = '';
  const actions: KeyActions = {
    insert: (t) => { buffer += t; },
    backspace: () => { buffer = buffer.slice(0, -1); },
    enter: () => { buffer += '\n'; },
    // mimic the adapter: a letter/digit then the just-typed space → replace the space with ". "; else plain space.
    sentenceSpace: () => {
      if (/[\p{L}\p{N}] $/u.test(buffer)) buffer = buffer.slice(0, -1) + '. ';
      else buffer += ' ';
    },
    // doc start / after newline / after sentence-terminator + space → capitalize next.
    shouldAutoCapitalize: () => buffer.length === 0 || /\n$/.test(buffer) || /[.!?]\s$/.test(buffer),
  };
  render(<Keypad actions={actions} />);
  return { text: () => buffer };
}

describe('Keypad — double-space → period (§7.1)', () => {
  it('a rapid second space replaces the trailing space with ". " after a letter', () => {
    const { text } = mountWithHost();
    tap('A'); tap('B');         // 'Ab' (the doc-start auto-cap caps the A; B releases to lower)
    tap('Space'); tap('Space'); // double-space → ". "
    expect(text()).toBe('Ab. ');
  });

  it('skips (plain double space) when there is no letter before the first space', () => {
    const { text } = mountWithHost();
    tap('Space'); tap('Space'); // nothing before → two plain spaces, no period
    expect(text()).toBe('  ');
  });

  it('a non-space key between the two spaces breaks the run (no period)', () => {
    const { text } = mountWithHost();
    tap('A'); tap('Space'); tap('B'); tap('Space');
    expect(text()).toBe('A b '); // A capitalized (doc start); the run broke at B → both spaces stay plain
  });
});

describe('Keypad — auto-capitalize (§7.3)', () => {
  it('arms the one-shot at doc start (mount): the first letter capitalizes, then releases', () => {
    const { text } = mountWithHost();
    expect(qFace()).toBe('Q'); // armed on mount (empty doc)
    tap('A');
    expect(text()).toBe('A');
    expect(qFace()).toBe('q'); // released
  });

  it('re-arms after a newline (Return)', () => {
    const { text } = mountWithHost();
    tap('A'); tap('B');  // 'Ab'
    tap('Return');       // 'Ab\n' → host says auto-cap
    expect(qFace()).toBe('Q');
    tap('C');
    expect(text()).toBe('Ab\nC');
  });

  it('re-arms after a double-space period (pairs with §7.1)', () => {
    const { text } = mountWithHost();
    tap('A'); tap('B');
    tap('Space'); tap('Space'); // → 'Ab. ' → new sentence
    expect(qFace()).toBe('Q');
    tap('C');
    expect(text()).toBe('Ab. C');
  });

  it('does not auto-cap mid-word (no boundary)', () => {
    const { text } = mountWithHost();
    tap('A');            // doc-start cap consumed → 'A', lower
    tap('B'); tap('C');  // mid-word, no boundary
    expect(text()).toBe('Abc');
  });
});
