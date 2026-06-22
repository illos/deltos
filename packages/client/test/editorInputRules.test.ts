/**
 * Deploy 3 — slice E: markdown-light input rules (spec §4 / §7.A). One assertion per trigger, driven
 * through the plugin's handleTextInput with a minimal fake view (no DOM). The uniqueBlockIdPlugin is in
 * the state so the blockId-interplay invariants are exercised: new nodes get fresh ids, a type change
 * keeps its id. Input rules share the toolbar commands, so a trigger ≡ the matching button.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorState as PMState, Transaction } from 'prosemirror-state';
import { deltoSchema } from '../src/editor/schema.js';
import { buildInputRulesPlugin } from '../src/editor/inputRules.js';
import { uniqueBlockIdPlugin } from '../src/editor/plugins/blockId.js';

const S = deltoSchema;
const inputPlugin = buildInputRulesPlugin(S);

/** Put `before` in a body paragraph, cursor at its end, then "type" lastChar through the input rules. */
function fire(before: string, lastChar: string): PMState {
  const para = S.node('paragraph', { id: 'p' }, before ? [S.text(before)] : []);
  const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), para]);
  let state = EditorState.create({ doc, schema: S, plugins: [inputPlugin, uniqueBlockIdPlugin] });
  const pos = state.doc.content.size - 1; // end of the paragraph's content
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  const view = { state, composing: false, dispatch: (tr: Transaction) => { state = state.apply(tr); } };
  inputPlugin.props!.handleTextInput!(view as never, pos, pos, lastChar);
  return state;
}
const block = (st: PMState) => st.doc.child(1);
function bodyHasMark(st: PMState, name: string): boolean {
  let found = false;
  block(st).forEach((c) => { if (c.marks.some((m) => m.type.name === name)) found = true; });
  return found;
}

describe('input rules — block triggers', () => {
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

describe('input rules — inline marks', () => {
  it('**b** → bold', () => { expect(bodyHasMark(fire('**b*', '*'), 'bold')).toBe(true); });
  it('*i* → italic', () => { expect(bodyHasMark(fire('*i', '*'), 'italic')).toBe(true); });
  it('~~s~~ → strikethrough', () => { expect(bodyHasMark(fire('~~s~', '~'), 'strikethrough')).toBe(true); });
  it('==h== → highlight', () => { expect(bodyHasMark(fire('==h=', '='), 'highlight')).toBe(true); });
  it('`c` → code', () => { expect(bodyHasMark(fire('`c', '`'), 'code')).toBe(true); });
});

describe('input rules — blockId interplay', () => {
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
    // Cursor in the title; typing "# " must NOT convert it.
    const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('#')])]);
    let state = EditorState.create({ doc, schema: S, plugins: [inputPlugin, uniqueBlockIdPlugin] });
    const pos = 2; // inside the title, after '#'
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    const view = { state, composing: false, dispatch: (tr: Transaction) => { state = state.apply(tr); } };
    inputPlugin.props!.handleTextInput!(view as never, pos, pos, ' ');
    expect(state.doc.child(0).type.name).toBe('title');
  });
});
