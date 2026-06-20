/**
 * Headless (node-env, no DOM) tests for editor undo/redo gate — task #44 Part A.
 *
 * UR-1  Rapid insertions collapse to a single undo step (grouping)
 * UR-2  Undo preserves block IDs — no stale ID resurrection after revert
 * UR-3  Redo cycle preserves block IDs
 * UR-4  titleEnter split can be undone without corrupting the title node
 * UR-5  Title never becomes two title nodes across undo/redo
 */

import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { history, undo, redo, undoDepth, redoDepth } from 'prosemirror-history';
import { deltoSchema } from '../src/editor/schema.js';
import { uniqueBlockIdPlugin } from '../src/editor/plugins/blockId.js';
import { buildKeymap } from '../src/editor/keymap.js';
import { HISTORY_GROUP_DELAY_MS as PM_EDITOR_DELAY } from '../src/editor/ProseMirrorEditor.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const text = (s: string) => deltoSchema.text(s);
const title = (id: string | null, s = 'Title') =>
  deltoSchema.node('title', { id }, [text(s)]);
const para = (id: string | null, s: string) =>
  deltoSchema.node('paragraph', { id }, [text(s)]);
const doc = (...blocks: PMNode[]) => deltoSchema.node('doc', null, blocks);

function mkState(d: PMNode): EditorState {
  return EditorState.create({
    doc: d,
    plugins: [history({ newGroupDelay: PM_EDITOR_DELAY }), uniqueBlockIdPlugin],
  });
}

/** Apply a command (undo/redo/Enter) against a state and return the resulting state. */
function applyCmd(state: EditorState, cmd: Command): EditorState {
  let next = state;
  cmd(state, (tr) => { next = state.apply(tr); });
  return next;
}

/** All ID-carrying block IDs in document order. */
function blockIds(d: PMNode): Array<string | null> {
  const ids: Array<string | null> = [];
  d.descendants((n) => {
    if (['title', 'paragraph', 'heading', 'blockquote', 'code_block'].includes(n.type.name)) {
      ids.push(n.attrs.id as string | null);
    }
  });
  return ids;
}

/** Count nodes of a given type in the document. */
function countType(d: PMNode, typeName: string): number {
  let count = 0;
  d.descendants((n) => { if (n.type.name === typeName) count++; });
  return count;
}

// ── UR-1: Grouping ─────────────────────────────────────────────────────────────

describe('UR-1 — rapid insertions collapse to one undo step', () => {
  it('inserts within the group delay form a single undo entry', () => {
    let state = mkState(doc(title('t-1', 'My Note'), para('p-1', 'hello')));

    // Insert 3 characters at the end of the paragraph (all synchronous → within group delay).
    for (let i = 0; i < 3; i++) {
      const pos = state.doc.content.size - 1; // just inside paragraph close tag
      state = state.apply(state.tr.insertText('x', pos));
    }

    // All three insertions should land in one undo group.
    expect(undoDepth(state)).toBe(1);
    expect(redoDepth(state)).toBe(0);

    // One undo reverts all three.
    state = applyCmd(state, undo);

    let paraText = '';
    state.doc.descendants((n) => { if (n.type.name === 'paragraph') paraText = n.textContent; });
    expect(paraText).toBe('hello'); // all 'x' chars gone

    expect(undoDepth(state)).toBe(0);
    expect(redoDepth(state)).toBe(1); // can redo
  });

  it('HISTORY_GROUP_DELAY_MS constant is exported and equals 500ms', () => {
    expect(PM_EDITOR_DELAY).toBe(500);
  });
});

// ── UR-2: Block ID preservation on undo ──────────────────────────────────────

describe('UR-2 — undo preserves block IDs', () => {
  it('existing block IDs are unchanged after undo', () => {
    let state = mkState(doc(title('t-1', 'Note'), para('p-1', 'hello')));

    // Apply a doc change (insert text) — blockId plugin keeps IDs stable.
    state = state.apply(state.tr.insertText('!', state.doc.content.size - 1));
    expect(blockIds(state.doc)).toEqual(['t-1', 'p-1']);

    // Undo the change.
    state = applyCmd(state, undo);

    // IDs must still be ['t-1', 'p-1'] — no nulls, no new UUIDs for existing blocks.
    const ids = blockIds(state.doc);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('t-1'); // title ID preserved
    expect(ids[1]).toBe('p-1'); // paragraph ID preserved
  });

  it('new paragraph added then undone does not leave orphan IDs', () => {
    let state = mkState(doc(title('t-1', 'Note'), para('p-1', 'body')));

    // Insert a new paragraph with null ID (blockId plugin will mint one).
    const newPara = deltoSchema.node('paragraph', { id: null }, [text('new')]);
    state = state.apply(state.tr.insert(state.doc.content.size, newPara));

    // Doc now has 3 blocks (title + body + new).
    expect(countType(state.doc, 'paragraph')).toBe(2);

    // Undo the insertion — new para removed.
    state = applyCmd(state, undo);

    expect(countType(state.doc, 'paragraph')).toBe(1);
    // Original IDs intact.
    expect(blockIds(state.doc)).toEqual(['t-1', 'p-1']);
  });
});

// ── UR-3: Block ID preservation on redo ──────────────────────────────────────

describe('UR-3 — redo cycle keeps block IDs stable', () => {
  it('undo then redo preserves IDs through the full cycle', () => {
    let state = mkState(doc(title('t-1', 'Note'), para('p-1', 'hello')));

    // Apply change.
    state = state.apply(state.tr.insertText('!', state.doc.content.size - 1));
    const idsAfterEdit = blockIds(state.doc);

    // Undo.
    state = applyCmd(state, undo);
    expect(blockIds(state.doc)).toEqual(['t-1', 'p-1']);

    // Redo.
    state = applyCmd(state, redo);
    // IDs after redo should match IDs after original edit.
    expect(blockIds(state.doc)).toEqual(idsAfterEdit);
    expect(blockIds(state.doc)).toEqual(['t-1', 'p-1']); // no new IDs
  });
});

// ── UR-4: titleEnter undo ─────────────────────────────────────────────────────

describe('UR-4 — titleEnter split undo does not corrupt the title node', () => {
  it('Enter at end of title splits → undo removes the split paragraph', () => {
    const titleText = 'My Title';
    let state = mkState(doc(title('t-1', titleText), para('p-1', 'body')));

    // Move selection to end of title text.
    // Title is the first node; content is "My Title" = 8 chars.
    // Pos 0 is the title-open token; pos 1..8 are the chars; pos 9 is title-close.
    const titleEndPos = 1 + titleText.length; // position after last title char
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, titleEndPos)),
    );

    // Apply Enter — titleEnter command splits title into title + new paragraph.
    const enterCmd = buildKeymap(deltoSchema)['Enter']!;
    state = applyCmd(state, enterCmd);

    // After split: title stays, a new empty paragraph is inserted, then the body para.
    const typesAfter: string[] = [];
    state.doc.forEach((n) => typesAfter.push(n.type.name));
    expect(typesAfter).toEqual(['title', 'paragraph', 'paragraph']);

    // Title is unchanged (same ID, same text).
    expect(state.doc.firstChild!.attrs.id).toBe('t-1');
    expect(state.doc.firstChild!.textContent).toBe(titleText);

    // Undo the Enter.
    state = applyCmd(state, undo);

    // Back to original structure.
    const typesAfterUndo: string[] = [];
    state.doc.forEach((n) => typesAfterUndo.push(n.type.name));
    expect(typesAfterUndo).toEqual(['title', 'paragraph']);

    // Title preserved.
    expect(state.doc.firstChild!.attrs.id).toBe('t-1');
    expect(state.doc.firstChild!.textContent).toBe(titleText);
    // Body para preserved.
    expect(state.doc.lastChild!.attrs.id).toBe('p-1');
  });
});

// ── UR-5: No double-title invariant ──────────────────────────────────────────

describe('UR-5 — title node count stays at exactly 1 across undo/redo', () => {
  it('no operation creates more than one title node', () => {
    let state = mkState(doc(title('t-1', 'T'), para('p-1', 'body')));

    // Several edits.
    state = state.apply(state.tr.insertText('!', state.doc.content.size - 1));
    state = state.apply(state.tr.insertText('?', state.doc.content.size - 1));
    expect(countType(state.doc, 'title')).toBe(1);

    // Undo all.
    state = applyCmd(state, undo);
    expect(countType(state.doc, 'title')).toBe(1);
    state = applyCmd(state, undo);
    expect(countType(state.doc, 'title')).toBe(1);

    // Redo all.
    state = applyCmd(state, redo);
    expect(countType(state.doc, 'title')).toBe(1);
    state = applyCmd(state, redo);
    expect(countType(state.doc, 'title')).toBe(1);
  });
});
