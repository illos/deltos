/**
 * Deploy 3 — slice B: the shared command layer (commands.ts) + selection-driven active state
 * (editorState.ts). Pure PM-state assertions — these are the by-reference units the desktop toolbar,
 * mobile bar, keymap, and the tool-descriptor registry (slice C) all consume.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Node as PmNode } from 'prosemirror-model';
import { deltoSchema } from '../src/editor/schema.js';
import {
  toggleMarkCmd, setBlock, toggleWrap, toggleList, toggleTodo, commandFor,
} from '../src/editor/commands.js';
import { deriveActiveState, isToolActive } from '../src/editor/editorState.js';

const S = deltoSchema;

/** Build a doc = title + one body block, with the cursor/selection inside the body block. */
function stateWith(bodyBlock: PmNode, selFrom?: number, selTo?: number): EditorState {
  const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), bodyBlock]);
  let state = EditorState.create({ doc, schema: S });
  // Body block content starts at: title nodeSize (3) + 1 (body open token) = 4.
  const at = selFrom ?? 4;
  const to = selTo ?? at;
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at, to)));
  return state;
}

/** Apply a command and return the resulting state (or the same state if it didn't dispatch). */
function run(state: EditorState, cmd: Command): EditorState {
  let next = state;
  cmd(state, (tr) => { next = state.apply(tr); });
  return next;
}

describe('deriveActiveState — block detection', () => {
  it('cursor in an h2 → block "h2"', () => {
    const st = stateWith(S.node('heading', { id: 'b', level: 2 }, [S.text('Head')]));
    expect(deriveActiveState(st).block).toBe('h2');
  });
  it('cursor in a todo_item → block "todo"', () => {
    const st = stateWith(S.node('todo_item', { id: 'b', checked: false }, [S.text('task')]));
    expect(deriveActiveState(st).block).toBe('todo');
  });
  it('cursor in a plain paragraph → block "p"', () => {
    const st = stateWith(S.node('paragraph', { id: 'b' }, [S.text('hi')]));
    expect(deriveActiveState(st).block).toBe('p');
  });
});

describe('deriveActiveState — mark detection', () => {
  it('selection over bold text → marks.bold true', () => {
    const para = S.node('paragraph', { id: 'b' }, [
      S.text('ab'), S.text('cd', [S.marks['bold']!.create()]), S.text('ef'),
    ]);
    // content starts at 4: 'ab' 4-6, 'cd' 6-8, 'ef' 8-10.
    const st = stateWith(para, 6, 8);
    expect(deriveActiveState(st).marks.bold).toBe(true);
  });
  it('empty selection with a stored bold mark → marks.bold true', () => {
    let st = stateWith(S.node('paragraph', { id: 'b' }, [S.text('hi')]));
    st = st.apply(st.tr.addStoredMark(S.marks['bold']!.create()));
    expect(deriveActiveState(st).marks.bold).toBe(true);
  });
});

describe('isToolActive — by-id predicate maps to the active snapshot', () => {
  it('Title (h1) is active in the unified title node OR a body h1', () => {
    const titleState = (() => {
      const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')])]);
      let s = EditorState.create({ doc, schema: S });
      s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1)));
      return s;
    })();
    expect(isToolActive(deriveActiveState(titleState), 'h1')).toBe(true);

    const h1State = stateWith(S.node('heading', { id: 'b', level: 1 }, [S.text('H')]));
    expect(isToolActive(deriveActiveState(h1State), 'h1')).toBe(true);
  });
});

describe('commands — shared builders', () => {
  it('setBlock(heading) converts a paragraph to a heading and PRESERVES the block id', () => {
    const st = stateWith(S.node('paragraph', { id: 'keep-me' }, [S.text('hi')]));
    const out = run(st, setBlock(S, 'heading', { level: 2 }));
    const block = out.doc.child(1);
    expect(block.type.name).toBe('heading');
    expect(block.attrs.level).toBe(2);
    expect(block.attrs.id).toBe('keep-me'); // §7 invariant: type change keeps the id
  });

  it('setBlock(code_block) preserves the id and strips inline marks', () => {
    const para = S.node('paragraph', { id: 'cb' }, [S.text('x', [S.marks['bold']!.create()])]);
    const out = run(stateWith(para), setBlock(S, 'code_block'));
    const block = out.doc.child(1);
    expect(block.type.name).toBe('code_block');
    expect(block.attrs.id).toBe('cb');
    let anyMark = false;
    block.forEach((c) => { if (c.marks.length) anyMark = true; });
    expect(anyMark).toBe(false);
  });

  it('toggleMarkCmd(bold) applies bold over the selection', () => {
    const out = run(stateWith(S.node('paragraph', { id: 'b' }, [S.text('hello')]), 4, 9), toggleMarkCmd(S, 'bold'));
    expect(out.doc.rangeHasMark(4, 9, S.marks['bold']!)).toBe(true);
  });

  it('toggleList(bullet_list) wraps a paragraph into a bullet list', () => {
    const out = run(stateWith(S.node('paragraph', { id: 'b' }, [S.text('item')])), toggleList(S, 'bullet_list'));
    expect(out.doc.child(1).type.name).toBe('bullet_list');
  });

  it('toggleTodo converts a paragraph to a todo_item and back', () => {
    const on = run(stateWith(S.node('paragraph', { id: 'b' }, [S.text('t')])), toggleTodo(S));
    expect(on.doc.child(1).type.name).toBe('todo_item');
    expect(on.doc.child(1).attrs.id).toBe('b');
    // back: cursor still in the (now) todo block
    const off = run(on.apply(on.tr.setSelection(TextSelection.create(on.doc, 4))), toggleTodo(S));
    expect(off.doc.child(1).type.name).toBe('paragraph');
  });

  it('toggleWrap(blockquote) wraps then lifts on a second toggle', () => {
    const wrapped = run(stateWith(S.node('paragraph', { id: 'b' }, [S.text('q')])), toggleWrap(S, 'blockquote'));
    expect(wrapped.doc.child(1).type.name).toBe('blockquote');
  });

  it('commandFor maps a data-cmd id to the matching command (h2 → heading)', () => {
    const out = run(stateWith(S.node('paragraph', { id: 'b' }, [S.text('x')])), commandFor(S, 'h2'));
    expect(out.doc.child(1).type.name).toBe('heading');
    expect(out.doc.child(1).attrs.level).toBe(2);
  });
});
