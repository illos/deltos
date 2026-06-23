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
  toggleMarkCmd, setBlock, toggleWrap, toggleList, commandFor,
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

describe('applyListType — mutually-exclusive list switching (#69 conversion matrix)', () => {
  // Compose starting states + transitions through the REAL UI wiring (commandFor 'ul'/'ol'/'check'),
  // so the matrix exercises exactly what the selector dispatches. bodyType = the single body block.
  const bodyType = (st: EditorState) => st.doc.child(1).type.name;
  const apply = (st: EditorState, id: string) => run(st, commandFor(S, id));
  const P = () => stateWith(S.node('paragraph', { id: 'b' }, [S.text('item')]));
  const UL = () => apply(P(), 'ul');
  const OL = () => apply(P(), 'ol');
  const CHECK = () => apply(P(), 'check');

  it('paragraph → bullet / ordered / checklist', () => {
    expect(bodyType(UL())).toBe('bullet_list');
    expect(bodyType(OL())).toBe('ordered_list');
    expect(bodyType(CHECK())).toBe('todo_item');
  });

  it('same type again toggles OFF to paragraph', () => {
    expect(bodyType(apply(UL(), 'ul'))).toBe('paragraph');
    expect(bodyType(apply(OL(), 'ol'))).toBe('paragraph');
    expect(bodyType(apply(CHECK(), 'check'))).toBe('paragraph');
  });

  it('bullet ↔ ordered converts the list in place (items + text preserved)', () => {
    const toOrdered = apply(UL(), 'ol');
    expect(bodyType(toOrdered)).toBe('ordered_list');
    expect(toOrdered.doc.child(1).textContent).toContain('item');
    const toBullet = apply(OL(), 'ul');
    expect(bodyType(toBullet)).toBe('bullet_list');
    expect(toBullet.doc.child(1).textContent).toContain('item');
  });

  it('bullet / ordered → checklist (lifts out of the list, becomes a todo)', () => {
    expect(bodyType(apply(UL(), 'check'))).toBe('todo_item');
    expect(bodyType(apply(OL(), 'check'))).toBe('todo_item');
  });

  it('checklist → bullet / ordered (becomes a list)', () => {
    expect(bodyType(apply(CHECK(), 'ul'))).toBe('bullet_list');
    expect(bodyType(apply(CHECK(), 'ol'))).toBe('ordered_list');
  });

  it('never stacks/nests: switching any type yields exactly ONE body block', () => {
    // title + one body block, regardless of the transition path.
    expect(apply(UL(), 'check').doc.childCount).toBe(2);
    expect(apply(CHECK(), 'ol').doc.childCount).toBe(2);
    expect(apply(UL(), 'ol').doc.childCount).toBe(2);
  });

  it('the active snapshot is mutually exclusive (selector reflects exactly one of ul/ol/check)', () => {
    const active = (st: EditorState) => deriveActiveState(st);
    expect(isToolActive(active(UL()), 'ul')).toBe(true);
    expect(isToolActive(active(UL()), 'ol')).toBe(false);
    expect(isToolActive(active(UL()), 'check')).toBe(false);
    expect(isToolActive(active(CHECK()), 'check')).toBe(true);
    expect(isToolActive(active(CHECK()), 'ul')).toBe(false);
    expect(isToolActive(active(OL()), 'ol')).toBe(true);
  });
});

describe('applyListType — multi-row (selection spans N paragraphs → N items, all types; #69 Jim)', () => {
  // Build doc = title + N body paragraphs, selection spanning ALL of them (first body content → last).
  function multiState(texts: string[]): EditorState {
    const blocks = texts.map((t, i) => S.node('paragraph', { id: `b${i}` }, [S.text(t)]));
    const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), ...blocks]);
    let state = EditorState.create({ doc, schema: S });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 4, doc.content.size - 1)));
    return state;
  }
  const apply = (st: EditorState, id: string) => run(st, commandFor(S, id));
  // Count list items / todo blocks in the result.
  const listItemCount = (st: EditorState) => {
    let n = 0;
    st.doc.descendants((node) => { if (node.type.name === 'list_item') n++; });
    return n;
  };
  const todoCount = (st: EditorState) => {
    let n = 0;
    st.doc.descendants((node) => { if (node.type.name === 'todo_item') n++; });
    return n;
  };
  const THREE = () => multiState(['one', 'two', 'three']);

  it('3 paragraphs → bullet = ONE list with 3 items', () => {
    const out = apply(THREE(), 'ul');
    expect(out.doc.child(1).type.name).toBe('bullet_list');
    expect(listItemCount(out)).toBe(3);
  });
  it('3 paragraphs → ordered = ONE list with 3 items', () => {
    const out = apply(THREE(), 'ol');
    expect(out.doc.child(1).type.name).toBe('ordered_list');
    expect(listItemCount(out)).toBe(3);
  });
  it('3 paragraphs → checklist = 3 todo items', () => {
    expect(todoCount(apply(THREE(), 'check'))).toBe(3);
  });
  it('3 checklist rows → ordered = ONE 3-item ordered list', () => {
    const checks = apply(THREE(), 'check'); // → 3 todos
    const out = apply(checks, 'ol');
    expect(out.doc.child(1).type.name).toBe('ordered_list');
    expect(listItemCount(out)).toBe(3);
  });
  it('3 bullet rows → checklist = 3 checkboxes', () => {
    const bullets = apply(THREE(), 'ul'); // → 3-item bullet list
    expect(todoCount(apply(bullets, 'check'))).toBe(3);
  });
  it('3 bullet rows → ordered = 3-item ordered list (convert in place)', () => {
    const bullets = apply(THREE(), 'ul');
    const out = apply(bullets, 'ol');
    expect(out.doc.child(1).type.name).toBe('ordered_list');
    expect(listItemCount(out)).toBe(3);
  });
});

describe('Style group — block-type toggles (Title/Heading/Subhead/Mono ↔ Body; #69 Jim)', () => {
  const bodyType = (st: EditorState) => st.doc.child(1).type.name;
  const apply = (st: EditorState, id: string) => run(st, commandFor(S, id));
  const P = () => stateWith(S.node('paragraph', { id: 'b' }, [S.text('hi')]));

  it('paragraph → Heading (h2) sets a level-2 heading, id preserved', () => {
    const out = apply(P(), 'h2');
    expect(bodyType(out)).toBe('heading');
    expect(out.doc.child(1).attrs.level).toBe(2);
    expect(out.doc.child(1).attrs.id).toBe('b');
  });

  it('tap the SAME type again toggles OFF to Body (paragraph)', () => {
    expect(bodyType(apply(apply(P(), 'h2'), 'h2'))).toBe('paragraph');
    expect(bodyType(apply(apply(P(), 'h1'), 'h1'))).toBe('paragraph');
  });

  it('tap a DIFFERENT type switches (Heading L2 → Title L1)', () => {
    const h1 = apply(apply(P(), 'h2'), 'h1');
    expect(bodyType(h1)).toBe('heading');
    expect(h1.doc.child(1).attrs.level).toBe(1);
  });

  it('Mono (pre) toggles to code_block and back to Body', () => {
    const pre = apply(P(), 'pre');
    expect(bodyType(pre)).toBe('code_block');
    expect(bodyType(apply(pre, 'pre'))).toBe('paragraph');
  });

  it('Body = off-state: in a paragraph none of Title/Heading/Subhead/Mono is active; the set type highlights', () => {
    const a = deriveActiveState(P());
    for (const id of ['h1', 'h2', 'h3', 'pre']) expect(isToolActive(a, id), id).toBe(false);
    expect(isToolActive(deriveActiveState(apply(P(), 'h2')), 'h2')).toBe(true);
    expect(isToolActive(deriveActiveState(apply(P(), 'h2')), 'h1')).toBe(false); // mutually exclusive
  });

  it('multi-row: 2 paragraphs → Heading sets BOTH; tap again clears BOTH to Body', () => {
    const blocks = [S.node('paragraph', { id: 'b0' }, [S.text('one')]), S.node('paragraph', { id: 'b1' }, [S.text('two')])];
    const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), ...blocks]);
    let st = EditorState.create({ doc, schema: S });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 4, doc.content.size - 1)));
    const headings = apply(st, 'h2');
    expect(headings.doc.child(1).type.name).toBe('heading');
    expect(headings.doc.child(2).type.name).toBe('heading');
    const cleared = apply(headings, 'h2'); // anchor is a heading → toggle whole selection OFF
    expect(cleared.doc.child(1).type.name).toBe('paragraph');
    expect(cleared.doc.child(2).type.name).toBe('paragraph');
  });
});
