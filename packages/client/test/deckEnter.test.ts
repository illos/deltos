/**
 * Deck ENTER parity ([ROAD-0007] step 3, D5 resolved — Jim, on-device 2026-07-03): the Deck ran only
 * `baseKeymap.Enter`, so Enter inside a list item did NOTHING and a todo never continued. Both keyboards
 * now consume ONE compiled Enter chain (boundary transforms → titleEnter → splitTodoItem → splitListItem →
 * base handlers). This suite drives every acceptance case through the DECK path (actions.enter()) and
 * mirrors the load-bearing ones through the hardware keymap — if the surfaces ever diverge, this goes red.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import type { Node as PmNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { deltoSchema as S } from '../src/editor/schema.js';
import { buildPmKeyActions } from '../src/editor/deckAdapter.js';
import { buildKeymap } from '../src/editor/keymap.js';
import { buildEditorTransformRegistry } from '../src/editor/editorTransforms.js';
import { createDefaultFormulaRegistry } from '../src/plugins/formula/index.js';
import { uniqueBlockIdPlugin } from '../src/editor/plugins/blockId.js';

const transforms = () => buildEditorTransformRegistry(S, createDefaultFormulaRegistry());

/** A minimal EditorView double over a real EditorState (blockId live so split ids mint like production). */
function makeView(...body: PmNode[]) {
  const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), ...body]);
  let state = EditorState.create({ doc, plugins: [uniqueBlockIdPlugin] });
  const view = {
    get state() { return state; },
    dispatch: (tr: Transaction) => { state = state.apply(tr); },
    focus: () => {},
  } as unknown as EditorView;
  const setCaret = (pos: number) => { state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos))); };
  const actions = buildPmKeyActions(() => view, transforms());
  const blocks = () => { const out: PmNode[] = []; view.state.doc.forEach((n) => out.push(n)); return out.slice(1); };
  return { view, setCaret, actions, blocks };
}

const bullet = (text: string) =>
  S.node('bullet_list', { id: 'l' }, [S.node('list_item', { id: 'li' }, [S.node('paragraph', { id: null }, [S.text(text)])])]);
const todo = (text: string, checked: boolean) =>
  S.node('todo_item', { id: 'td', checked }, text ? [S.text(text)] : []);

describe('Deck Enter — list items (the live-broken case)', () => {
  it('Enter mid-bullet-item SPLITS the item (was: nothing happened)', () => {
    const h = makeView(bullet('hello'));
    // Caret after "hel": title(3) + list open(1)+item open(1)+para open(1) + 3 chars
    h.setCaret(3 + 3 + 3);
    h.actions.enter();
    const list = h.blocks()[0]!;
    expect(list.type.name).toBe('bullet_list');
    expect(list.childCount).toBe(2); // two items now
    expect(list.child(0).textContent).toBe('hel');
    expect(list.child(1).textContent).toBe('lo');
  });

  it('Enter on an EMPTY list item lifts out of the list (standard exit)', () => {
    const h = makeView(S.node('bullet_list', { id: 'l' }, [
      S.node('list_item', { id: 'a' }, [S.node('paragraph', { id: null }, [S.text('kept')])]),
      S.node('list_item', { id: 'b' }, [S.node('paragraph', { id: null })]),
    ]));
    h.setCaret(h.view.state.doc.content.size - 3); // inside the empty second item
    h.actions.enter();
    const blocks = h.blocks();
    expect(blocks[0]!.type.name).toBe('bullet_list');
    expect(blocks[0]!.childCount).toBe(1); // the empty item left the list…
    expect(blocks[1]!.type.name).toBe('paragraph'); // …and became a body paragraph
  });
});

describe('Deck Enter — todo items (Jim: Enter must continue the checklist)', () => {
  it('Enter at the end of a todo → a NEW UNCHECKED todo below', () => {
    const h = makeView(todo('buy milk', false));
    h.setCaret(3 + 1 + 8); // end of "buy milk"
    h.actions.enter();
    const [a, b] = h.blocks();
    expect(a!.type.name).toBe('todo_item');
    expect(a!.textContent).toBe('buy milk');
    expect(b!.type.name).toBe('todo_item');
    expect(b!.textContent).toBe('');
    expect(b!.attrs.checked).toBe(false);
  });

  it('Enter on a CHECKED todo → the new item is UNCHECKED (checked never carries over)', () => {
    const h = makeView(todo('done thing', true));
    h.setCaret(3 + 1 + 10);
    h.actions.enter();
    const [a, b] = h.blocks();
    expect(a!.attrs.checked).toBe(true); // the split item keeps its state
    expect(b!.attrs.checked).toBe(false); // the continuation starts unchecked
    expect(b!.attrs.id).not.toBe(a!.attrs.id); // fresh id minted, never a duplicate
  });

  it('Enter mid-todo splits the text across the two items', () => {
    const h = makeView(todo('buy milk', false));
    h.setCaret(3 + 1 + 3); // after "buy"
    h.actions.enter();
    const [a, b] = h.blocks();
    expect(a!.textContent).toBe('buy');
    expect(b!.textContent).toBe(' milk');
    expect(b!.type.name).toBe('todo_item');
  });

  it('Enter on an EMPTY todo exits the checklist (becomes a paragraph)', () => {
    const h = makeView(todo('', false));
    h.setCaret(3 + 1);
    h.actions.enter();
    expect(h.blocks()[0]!.type.name).toBe('paragraph');
  });
});

describe('Deck Enter — title + surface parity', () => {
  it('Enter in the title splits into title + body paragraph (titleEnter preserved)', () => {
    const h = makeView(S.node('paragraph', { id: 'p' }, [S.text('body')]));
    h.setCaret(2); // inside the title text
    h.actions.enter();
    expect(h.view.state.doc.child(0).type.name).toBe('title');
    expect(h.view.state.doc.child(1).type.name).toBe('paragraph'); // the split-off remainder
  });

  it('HARDWARE Enter on a todo does the same (the fix is shared, not Deck-only)', () => {
    const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), todo('buy milk', true)]);
    let state = EditorState.create({ doc, plugins: [uniqueBlockIdPlugin] });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3 + 1 + 8)));
    const keys = buildKeymap(S, transforms());
    keys['Enter']!(state, (tr) => { state = state.apply(tr); });
    expect(state.doc.child(1).type.name).toBe('todo_item');
    expect(state.doc.child(2).type.name).toBe('todo_item');
    expect(state.doc.child(2).attrs.checked).toBe(false);
  });
});
