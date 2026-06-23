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
    tap('Shift');
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
    tap('Shift'); // arm uppercase on the letters layer
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
