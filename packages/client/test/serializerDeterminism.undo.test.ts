/**
 * Regression: undo/redo was DEAD on any note containing a list / checklist / blockquote / plugin block.
 *
 * Root cause: spineToPmDoc() minted FRESH random ids for render-only inner nodes (list_item inner paragraph,
 * blockquote first paragraph, plugin-block wrapper paragraph) every call. Those ids are NOT round-tripped into
 * the spine (pmDocToSpine discards them). So the #90 live-reconcile echo-guard — `if (incoming.eq(doc)) return`
 * where `incoming = spineToPmDoc(pmDocToSpine(doc))` — never matched the editor's own autosave echo, ran a full
 * `replaceWith(... addToHistory:false)`, and wiped the undo stack on every 400ms autosave.
 *
 * The fix makes spineToPmDoc DETERMINISTIC (stable derived / null inner ids) so the round-trip reproduces the
 * live doc byte-for-byte → the guard short-circuits → history survives. These tests pin all three properties:
 *   1. DETERMINISM   — spineToPmDoc(spine).eq(spineToPmDoc(spine)) for list/quote/checklist/plugin content.
 *   2. ECHO-GUARD    — after a real edit, spineToPmDoc(pmDocToSpine(doc)).eq(doc) short-circuits the reconcile.
 *   3. UNDO SURVIVES — running the actual reconcile decision after an edit leaves history intact (undo reverts).
 *   4. ROUND-TRIP    — pmDocToSpine(spineToPmDoc(spine)) still deep-equals the original spine (data unchanged).
 */

import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { history, undo } from 'prosemirror-history';
import type { BlockBody, BlockId } from '@deltos/shared';
import { deltoSchema } from '../src/editor/schema.js';
import { uniqueBlockIdPlugin } from '../src/editor/plugins/blockId.js';
import { buildKeymapPlugin } from '../src/editor/keymap.js';
import { HISTORY_GROUP_DELAY_MS } from '../src/editor/ProseMirrorEditor.js';
import { spineToPmDoc, pmDocToSpine } from '../src/editor/serializer.js';

// ── Fixtures: one spine per "broken" content kind ────────────────────────────────
const id = (n: string) => n as BlockId;

const LIST: BlockBody = [
  { id: id('list-1'), type: 'list', content: { ordered: false }, children: [
    { id: id('li-1'), type: 'paragraph', content: { segments: [{ text: 'hello' }] } },
    { id: id('li-2'), type: 'paragraph', content: { segments: [{ text: 'world' }] } },
  ] },
];
const CHECKLIST: BlockBody = [
  { id: id('clist-1'), type: 'list', content: { ordered: false }, children: [
    { id: id('todo-1'), type: 'todo', content: { checked: false, segments: [{ text: 'task' }] } },
    { id: id('todo-2'), type: 'todo', content: { checked: true, segments: [{ text: 'done' }] } },
  ] },
];
const QUOTE: BlockBody = [
  { id: id('q-1'), type: 'quote', content: { segments: [{ text: 'a wise quote' }] } },
];
const PLUGIN: BlockBody = [
  { id: id('atom-1'), type: 'attachment', content: { blobHash: 'abc', name: 'f.png' } },
  { id: id('p-after'), type: 'paragraph', content: { segments: [{ text: 'caption' }] } },
];

const FIXTURES: Array<[string, BlockBody]> = [
  ['list', LIST],
  ['checklist', CHECKLIST],
  ['blockquote', QUOTE],
  ['plugin block', PLUGIN],
];

// ── Full base plugin stack (the load-bearing trio for this bug) ──────────────────
function mkState(doc: PMNode): EditorState {
  return EditorState.create({
    doc,
    plugins: [
      history({ newGroupDelay: HISTORY_GROUP_DELAY_MS }),
      buildKeymapPlugin(deltoSchema),
      uniqueBlockIdPlugin,
    ],
  });
}

function applyCmd(state: EditorState, cmd: Command): EditorState {
  let next = state;
  cmd(state, (tr) => { next = state.apply(tr); });
  return next;
}

/** The exact #90 reconcile DECISION: returns the next state after the autosave echo. */
function reconcileEcho(state: EditorState): { state: EditorState; replaced: boolean } {
  const title = state.doc.firstChild?.type.name === 'title' ? state.doc.firstChild.textContent : '';
  const incoming = spineToPmDoc(deltoSchema, pmDocToSpine(state.doc), title);
  if (incoming.eq(state.doc)) return { state, replaced: false }; // guard short-circuits → no-op (good)
  // Buggy path: full replace with history suppressed → wipes the undo stack.
  const tr = state.tr.replaceWith(0, state.doc.content.size, incoming.content);
  tr.setMeta('addToHistory', false);
  return { state: state.apply(tr), replaced: true };
}

/**
 * Insert text at the end of the first ordinary text block — skipping the render-only paragraph that WRAPS an
 * inline plugin atom (typing INTO that paragraph triggers the documented atom+text → multi-block split on save,
 * which is an orthogonal, pre-existing non-round-trip; the realistic edit touches a separate text block).
 */
function typeIntoFirstText(state: EditorState, append: string): EditorState {
  let target = -1;
  state.doc.descendants((n, pos) => {
    if (target !== -1) return;
    if (!((n.type.name === 'paragraph' || n.type.name === 'todo_item') && n.isTextblock)) return;
    let hasAtom = false;
    n.forEach((c) => { if (c.type.isAtom && c.isInline && !c.isText) hasAtom = true; });
    if (hasAtom) return;
    target = pos + 1 + n.content.size; // end of this textblock's inline content
  });
  return state.apply(state.tr.insertText(append, target));
}

// ── 1. DETERMINISM ───────────────────────────────────────────────────────────────
describe('spineToPmDoc is deterministic (identical ids every call)', () => {
  for (const [name, spine] of FIXTURES) {
    it(`${name}: spineToPmDoc(spine).eq(spineToPmDoc(spine))`, () => {
      const a = spineToPmDoc(deltoSchema, spine, 'Title');
      const b = spineToPmDoc(deltoSchema, spine, 'Title');
      expect(a.eq(b)).toBe(true);
    });
  }
});

// ── 2. ECHO-GUARD short-circuits the local-save round-trip ───────────────────────
describe('#90 reconcile guard: spineToPmDoc(pmDocToSpine(doc)).eq(doc) after an edit', () => {
  for (const [name, spine] of FIXTURES) {
    it(`${name}: the autosave echo is a no-op (guard short-circuits)`, () => {
      let state = mkState(spineToPmDoc(deltoSchema, spine, 'Title'));
      state = typeIntoFirstText(state, '!!!');
      const { replaced } = reconcileEcho(state);
      expect(replaced).toBe(false);
    });
  }
});

// ── 3. UNDO SURVIVES the reconcile ───────────────────────────────────────────────
describe('undo survives the autosave reconcile (the regression)', () => {
  for (const [name, spine] of FIXTURES) {
    it(`${name}: edit → reconcile → undo still reverts the edit`, () => {
      let state = mkState(spineToPmDoc(deltoSchema, spine, 'Title'));
      const before = state.doc.textContent;
      state = typeIntoFirstText(state, 'XYZ');
      expect(state.doc.textContent).toContain('XYZ');
      // The reactive re-emit fires the reconcile effect:
      state = reconcileEcho(state).state;
      // Undo MUST revert the user's edit — i.e. history was preserved.
      state = applyCmd(state, undo);
      expect(state.doc.textContent).not.toContain('XYZ');
      expect(state.doc.textContent).toBe(before);
    });
  }
});

// ── 3b. UNDO survives even for a SESSION-CREATED list item (split → new inner para) ──
describe('undo survives for a list item added during the session', () => {
  it('add a fresh list item (null inner id, as PM split + plugin produce), reconcile → undo still works', () => {
    let state = mkState(spineToPmDoc(deltoSchema, LIST, 'Title'));
    // A freshly split list item arrives with a NULL list_item id (plugin mints it) AND a NULL inner-paragraph
    // id (plugin now LEAVES it null). Insert exactly that shape inside the bullet_list.
    const newItem = deltoSchema.node('list_item', { id: null }, [
      deltoSchema.node('paragraph', { id: null }, [deltoSchema.text('fresh')]),
    ]);
    let listEnd = -1;
    state.doc.descendants((n, pos) => {
      if (n.type.name === 'bullet_list') listEnd = pos + n.nodeSize - 1; // just inside the list close token
    });
    state = state.apply(state.tr.insert(listEnd, newItem)); // appendTransaction mints the list_item id only
    expect(state.doc.textContent).toContain('fresh');

    // The new list_item got a real minted id; its inner paragraph stays null → the round-trip reproduces it.
    const { replaced } = reconcileEcho(state);
    expect(replaced).toBe(false); // echo-guard holds even for the freshly-created item

    state = applyCmd(state, undo);
    expect(state.doc.textContent).not.toContain('fresh');
  });
});

// ── 4. ROUND-TRIP: the stored spine is unchanged ─────────────────────────────────
describe('round-trip: pmDocToSpine(spineToPmDoc(spine)) deep-equals the spine', () => {
  for (const [name, spine] of FIXTURES) {
    it(`${name}: data model unchanged`, () => {
      const back = pmDocToSpine(spineToPmDoc(deltoSchema, spine, 'Title'));
      expect(back).toEqual(spine);
    });
  }
});
