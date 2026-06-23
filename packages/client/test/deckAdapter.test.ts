/**
 * deckAdapter — the deltos↔Deck boundary's PM-specific logic (§7 increment 2). Tests the real
 * ProseMirror transactions behind the new KeyActions intents (sentenceSpace, shouldAutoCapitalize,
 * moveCaret-horizontal) against a real EditorState. The keypad's emit-side is covered separately in
 * keyboard.render; this covers the host mapping the keypad stays agnostic of.
 *
 * moveCaret's VERTICAL step uses the view's layout coords (coordsAtPos/posAtCoords) which jsdom doesn't
 * lay out — that path is behavior-verified on-device, not unit-tested here; horizontal is fully covered.
 */
import { describe, it, expect } from 'vitest';
import { Schema } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { buildPmKeyActions } from '../src/editor/deckAdapter.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    text: {},
  },
  marks: {},
});

/** A minimal EditorView double: real EditorState + dispatch(apply); layout coords stubbed (unused here). */
function makeView(paragraphs: string[]) {
  const doc = schema.node('doc', null, paragraphs.map((t) => schema.node('paragraph', null, t ? [schema.text(t)] : [])));
  let state = EditorState.create({ doc, schema });
  // caret at the very end of the doc
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const view = {
    get state() { return state; },
    dispatch: (tr: ReturnType<typeof state.tr.insertText>) => { state = state.apply(tr); },
    focus: () => {},
    coordsAtPos: () => ({ top: 0, bottom: 16, left: 0, right: 0 }),
    posAtCoords: () => null,
  } as unknown as EditorView;
  return {
    view,
    text: () => view.state.doc.textContent,
    head: () => view.state.selection.head,
    setCaret: (pos: number) => { state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos))); },
  };
}

describe('deckAdapter — sentenceSpace (§7.1)', () => {
  it('replaces a trailing "<letter> " with ". "', () => {
    const h = makeView(['hi ']);
    buildPmKeyActions(() => h.view).sentenceSpace!();
    expect(h.text()).toBe('hi. ');
  });

  it('falls back to a plain space when there is no letter before the trailing space', () => {
    const h = makeView([' ']); // single leading space, no letter
    buildPmKeyActions(() => h.view).sentenceSpace!();
    expect(h.text()).toBe('  '); // two plain spaces, no period
  });

  it('falls back to a plain space after existing punctuation (skip rule)', () => {
    const h = makeView(['hi. ']); // already a sentence end + space
    buildPmKeyActions(() => h.view).sentenceSpace!();
    expect(h.text()).toBe('hi.  '); // just adds a space — no double period
  });
});

describe('deckAdapter — shouldAutoCapitalize (§7.3)', () => {
  const should = (paragraphs: string[], caret?: number) => {
    const h = makeView(paragraphs);
    if (caret !== undefined) h.setCaret(caret);
    return buildPmKeyActions(() => h.view).shouldAutoCapitalize!();
  };
  it('true at doc start (empty)', () => { expect(should([''])).toBe(true); });
  it('true at the start of a later line (block start)', () => {
    // caret at start of the 2nd paragraph: doc = <p>hi</p><p></p>; end is inside the empty 2nd para → offset 0
    expect(should(['hi', ''])).toBe(true);
  });
  it('true after a sentence terminator + space', () => { expect(should(['done. '])).toBe(true); });
  it('false mid-word', () => { expect(should(['hello'])).toBe(false); });
  it('false after a plain word + single space (not a sentence end)', () => { expect(should(['hello '])).toBe(false); });
});

describe('deckAdapter — moveCaret horizontal (§7.4)', () => {
  it('moves the caret left/right by char steps (relative)', () => {
    const h = makeView(['hello']);
    const actions = buildPmKeyActions(() => h.view);
    const end = h.head();
    actions.moveCaret!(-2, 0);
    expect(h.head()).toBe(end - 2);
    actions.moveCaret!(1, 0);
    expect(h.head()).toBe(end - 1);
  });

  it('clamps at the document bounds', () => {
    const h = makeView(['hi']);
    const actions = buildPmKeyActions(() => h.view);
    actions.moveCaret!(-999, 0);
    expect(h.head()).toBe(1); // start of the text in the paragraph (clamped, not negative)
  });
});
