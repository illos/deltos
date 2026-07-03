/**
 * Deck dual-wiring GATE ([[deck-keypad-bypasses-inputrules-keymap]]). The on-screen Deck keypad inserts via
 * the deckAdapter (dispatched transactions) and BYPASSES the PM keymap entirely — so Mechanic A (single-press
 * block-object delete) and Mechanic B (formula backspace-unwrap) must be invoked from `buildPmKeyActions`
 * too, or they fire ONLY on a hardware keyboard and NOT on Jim's primary mobile path.
 *
 * This drives the delete through the DECK ADAPTER PATH (actions.backspace()), NOT the keymap, over the REAL
 * deltoSchema — the keymap chain is covered by blockObjectChrome.test.ts / formulaUnwrap.test.ts. If the
 * dual-wiring regresses, these go red while the keymap tests stay green.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { deltoSchema as S } from '../src/editor/schema.js';
import { buildPmKeyActions } from '../src/editor/deckAdapter.js';
import { createDefaultFormulaRegistry } from '../src/plugins/formula/index.js';
import { buildEditorTransformRegistry } from '../src/editor/editorTransforms.js';

const transforms = buildEditorTransformRegistry(S, createDefaultFormulaRegistry());

/** A minimal EditorView double: a real EditorState + dispatch(apply); layout coords stubbed (unused here). */
function makeView(body: ReturnType<typeof S.node>) {
  const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), body]);
  let state = EditorState.create({ doc, schema: S });
  const view = {
    get state() { return state; },
    dispatch: (tr: ReturnType<typeof state.tr.insertText>) => { state = state.apply(tr); },
    focus: () => {},
    coordsAtPos: () => ({ top: 0, bottom: 16, left: 0, right: 0 }),
    posAtCoords: () => null,
  } as unknown as EditorView;
  const setCaret = (pos: number) => { state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos))); };
  const backspace = () => buildPmKeyActions(() => view, transforms).backspace();
  const has = (typeName: string) => { let f = false; view.state.doc.descendants((n) => { if (n.type.name === typeName) f = true; }); return f; };
  const posOf = (typeName: string) => { let p = -1, size = 0; view.state.doc.descendants((n, pos) => { if (n.type.name === typeName) { p = pos; size = n.nodeSize; } }); return { p, size }; };
  return { view, setCaret, backspace, has, posOf, text: () => view.state.doc.child(1).textContent };
}

describe('Deck dual-wiring — Mechanic A: block-object single-press delete through the keypad adapter', () => {
  it('Deck backspace right AFTER a block-object atom deletes it as ONE unit (single press)', () => {
    const h = makeView(S.node('paragraph', { id: 'p' }, [
      S.node('plugin_block', { id: 'c', pluginType: 'attachment', pluginContent: { name: 'f.png' } }),
    ]));
    const { p, size } = h.posOf('plugin_block');
    h.setCaret(p + size); // caret immediately after the atom
    expect(h.has('plugin_block')).toBe(true);
    h.backspace();
    expect(h.has('plugin_block')).toBe(false); // gone on the FIRST press, via the Deck path
    expect(h.view.state.doc.child(1).type.name).toBe('paragraph'); // the empty line remains
  });
});

describe('Deck dual-wiring — Mechanic B: formula backspace-unwrap through the keypad adapter', () => {
  it('Deck backspace right AFTER a math chip unwraps it to its "2+2" source (not delete)', () => {
    const f = S.nodes['formula']!.create({ ftype: 'math', state: null }, S.text('2+2'));
    const h = makeView(S.node('paragraph', { id: 'p' }, [f]));
    const { p, size } = h.posOf('formula');
    h.setCaret(p + size); // caret immediately after the chip
    h.backspace();
    expect(h.has('formula')).toBe(false); // unwrapped, not deleted
    expect(h.text()).toBe('2+2'); // the editable source is left in place
  });
});

describe('Deck dual-wiring — additive: plain text still char-deletes (no regression)', () => {
  it('Deck backspace mid-text deletes ONE character (the wirings are inert off an object edge)', () => {
    const h = makeView(S.node('paragraph', { id: 'p' }, [S.text('hello')]));
    const { p } = h.posOf('paragraph');
    h.setCaret(p + 1 + 'hello'.length); // caret at the end of "hello"
    h.backspace();
    expect(h.text()).toBe('hell'); // exactly one char gone — not the whole word/atom path
  });
});
