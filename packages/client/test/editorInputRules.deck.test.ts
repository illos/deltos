/**
 * Markdown-light transforms, DECK surface ([ROAD-0007] step 1) — the mirror of editorInputRules.test.ts,
 * driven through `deckAdapter.insert` (the keypad path) instead of handleTextInput. THIS is the suite
 * that pins the origin bug fix: the Deck bypasses ProseMirror's whole input pipeline
 * ([[deck-keypad-bypasses-inputrules-keymap]]), so markdown silently never converted there until the
 * unified pipeline gave the adapter one generic runner call. Every trigger asserted natively is asserted
 * here through the adapter — with the REAL formula registry in front, matching production order
 * (formula trigger first, then the pipeline runner).
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorState as PMState, Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { deltoSchema } from '../src/editor/schema.js';
import { registerMarkdownTransforms } from '../src/editor/inputRules.js';
import { TransformRegistry, buildInputPipelinePlugin } from '../src/editor/inputPipeline/index.js';
import { uniqueBlockIdPlugin } from '../src/editor/plugins/blockId.js';
import { buildPmKeyActions } from '../src/editor/deckAdapter.js';
import { createDefaultFormulaRegistry } from '../src/plugins/formula/index.js';

const S = deltoSchema;
const formulaRegistry = createDefaultFormulaRegistry();

function makeRegistry(): TransformRegistry {
  const r = new TransformRegistry();
  registerMarkdownTransforms(r, S);
  return r;
}

/** Put `before` in a body paragraph, caret at its end, then press `lastChar` ON THE KEYPAD. */
function fire(before: string, lastChar: string): PMState {
  const registry = makeRegistry();
  const para = S.node('paragraph', { id: 'p' }, before ? [S.text(before)] : []);
  const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), para]);
  let state = EditorState.create({
    doc,
    schema: S,
    plugins: [buildInputPipelinePlugin(registry), uniqueBlockIdPlugin],
  });
  const pos = state.doc.content.size - 1; // end of the paragraph's content
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  const view = {
    get state() { return state; },
    dispatch: (tr: Transaction) => { state = state.apply(tr); },
    focus: () => {},
  } as unknown as EditorView;
  buildPmKeyActions(() => view, formulaRegistry, registry).insert(lastChar);
  return state;
}
const block = (st: PMState) => st.doc.child(1);
function bodyHasMark(st: PMState, name: string): boolean {
  let found = false;
  block(st).forEach((c) => { if (c.marks.some((m) => m.type.name === name)) found = true; });
  return found;
}

describe('Deck markdown — block triggers (via deckAdapter.insert)', () => {
  it('# → h1', () => { const b = block(fire('#', ' ')); expect(b.type.name).toBe('heading'); expect(b.attrs.level).toBe(1); });
  it('## → h2', () => { const b = block(fire('##', ' ')); expect(b.type.name).toBe('heading'); expect(b.attrs.level).toBe(2); });
  it('### → h3', () => { const b = block(fire('###', ' ')); expect(b.type.name).toBe('heading'); expect(b.attrs.level).toBe(3); });
  it('> → blockquote', () => { expect(block(fire('>', ' ')).type.name).toBe('blockquote'); });
  it('``` → code_block', () => { expect(block(fire('``', '`')).type.name).toBe('code_block'); });
  it('- → bullet_list', () => { expect(block(fire('-', ' ')).type.name).toBe('bullet_list'); });
  it('* → bullet_list', () => { expect(block(fire('*', ' ')).type.name).toBe('bullet_list'); });
  it('1. → ordered_list', () => { expect(block(fire('1.', ' ')).type.name).toBe('ordered_list'); });
  it('[] → todo_item', () => { expect(block(fire('[]', ' ')).type.name).toBe('todo_item'); });
  it('[ ] → todo_item', () => { expect(block(fire('[ ]', ' ')).type.name).toBe('todo_item'); });
  it('--- → horizontal_rule + trailing paragraph', () => {
    const st = fire('--', '-');
    expect(st.doc.child(1).type.name).toBe('horizontal_rule');
    expect(st.doc.child(2).type.name).toBe('paragraph');
  });
});

describe('Deck markdown — inline marks (via deckAdapter.insert)', () => {
  it('**b** → bold', () => { expect(bodyHasMark(fire('**b*', '*'), 'bold')).toBe(true); });
  it('*i* → italic', () => { expect(bodyHasMark(fire('*i', '*'), 'italic')).toBe(true); });
  it('~~s~~ → strikethrough', () => { expect(bodyHasMark(fire('~~s~', '~'), 'strikethrough')).toBe(true); });
  it('==h== → highlight', () => { expect(bodyHasMark(fire('==h=', '='), 'highlight')).toBe(true); });
  it('`c` → code', () => { expect(bodyHasMark(fire('`c', '`'), 'code')).toBe(true); });
});

describe('Deck markdown — blockId interplay + guards', () => {
  it('paragraph→heading keeps the existing block id (no spurious re-mint)', () => {
    expect(block(fire('#', ' ')).attrs.id).toBe('p');
  });
  it('--- mints fresh, distinct, non-null ids for the hr and the trailing paragraph', () => {
    const st = fire('--', '-');
    const hrId = st.doc.child(1).attrs.id as string | null;
    const pId = st.doc.child(2).attrs.id as string | null;
    expect(hrId).toBeTruthy();
    expect(pId).toBeTruthy();
    expect(hrId).not.toBe(pId);
  });
  it('a trigger in the unified title node is inert (title stays title)', () => {
    const registry = makeRegistry();
    const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('#')])]);
    let state = EditorState.create({
      doc,
      schema: S,
      plugins: [buildInputPipelinePlugin(registry), uniqueBlockIdPlugin],
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
    const view = {
      get state() { return state; },
      dispatch: (tr: Transaction) => { state = state.apply(tr); },
      focus: () => {},
    } as unknown as EditorView;
    buildPmKeyActions(() => view, formulaRegistry, registry).insert(' ');
    expect(state.doc.child(0).type.name).toBe('title');
    expect(state.doc.child(0).textContent).toBe('# '); // the space still lands as plain text
  });
  it('a non-matching char just inserts (the runner declining falls through to plain insert)', () => {
    const st = fire('hello', '!');
    expect(block(st).type.name).toBe('paragraph');
    expect(block(st).textContent).toBe('hello!');
  });
});
