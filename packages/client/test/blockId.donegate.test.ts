/**
 * v1 DONE-GATE — DG-2d (Tier-A, client-hosted): block IDs stay UNIQUE + STABLE across the transforms
 * that ProseMirror would otherwise duplicate them through (split / paste / merge). [Stream C block-ID]
 *
 * Pure-editor test of the EXISTING uniqueBlockIdPlugin (no plugin change, no worker app) — hosted in
 * the client pkg because prosemirror-state/model are pnpm-isolated here (scopeSys/pilot ruling); it is
 * the client sibling of the worker-hosted Tier-A rows. Single-editor: devSys2.
 *
 * The plugin runs as appendTransaction: mints a fresh id on any block lacking one, and re-mints
 * DUPLICATE ids (paste/split copies) while PRESERVING the prior owner's id — so existing block ids
 * never silently change, only newly-inserted copies get fresh ids.
 */

import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { deltoSchema } from '../src/editor/schema.js';
import { uniqueBlockIdPlugin } from '../src/editor/plugins/blockId.js';

const text = (s: string) => deltoSchema.text(s);
const title = (id: string | null, s = 'Title') => deltoSchema.node('title', { id }, [text(s)]);
const para = (id: string | null, s: string) => deltoSchema.node('paragraph', { id }, [text(s)]);
const doc = (...blocks: PMNode[]) => deltoSchema.node('doc', null, blocks);
const mkState = (d: PMNode) => EditorState.create({ doc: d, plugins: [uniqueBlockIdPlugin] });

/** All block ids in document order (title + paragraphs carry an `id` attr). */
function blockIds(d: PMNode): Array<string | null> {
  const ids: Array<string | null> = [];
  d.descendants((n) => {
    if (n.type.name === 'title' || n.type.name === 'paragraph') ids.push(n.attrs.id as string | null);
  });
  return ids;
}
const allUnique = (ids: Array<string | null>) => new Set(ids).size === ids.length;

describe('DG-2d — block ids unique + stable through transforms', () => {
  it('mints a fresh unique id for every block that lacks one (new/inserted nodes)', () => {
    const state = mkState(doc(title(null), para(null, 'a'), para(null, 'b')));
    // Any doc-changing tx triggers the plugin's appendTransaction; inserting a (null-id) block does it.
    const tr = state.tr.insert(state.doc.content.size, para(null, 'c'));
    const next = state.apply(tr);

    const ids = blockIds(next.doc);
    expect(ids).toHaveLength(4);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true); // all minted
    expect(allUnique(ids)).toBe(true); // all distinct
  });

  it('re-mints a DUPLICATE id (paste/split copy) but PRESERVES the prior owner', () => {
    const state = mkState(doc(title('t-1'), para('p-1', 'original'), para('p-2', 'b')));
    // Simulate a paste/split: insert a NEW paragraph carrying an EXISTING id ('p-1') → duplicate.
    const tr = state.tr.insert(state.doc.content.size, para('p-1', 'pasted copy'));
    const next = state.apply(tr);

    const ids = blockIds(next.doc);
    expect(allUnique(ids)).toBe(true); // the duplicate was resolved

    // Prior owner keeps 'p-1' (existing ids never silently change); the pasted copy got a fresh id.
    let originalId: string | null = null;
    let copyId: string | null = null;
    next.doc.descendants((n) => {
      if (n.type.name !== 'paragraph') return;
      if (n.textContent === 'original') originalId = n.attrs.id as string;
      if (n.textContent === 'pasted copy') copyId = n.attrs.id as string;
    });
    expect(originalId).toBe('p-1'); // prior owner preserved
    expect(copyId).not.toBe('p-1'); // copy re-minted
    expect(typeof copyId).toBe('string');
  });

  it('leaves already-unique ids UNTOUCHED through a non-duplicating structural change (stability)', () => {
    const state = mkState(doc(title('t-1'), para('p-1', 'a'), para('p-2', 'b')));
    // Insert a block with a fresh unique id — no null, no duplicate → existing ids must be stable.
    const tr = state.tr.insert(state.doc.content.size, para('p-3', 'c'));
    const next = state.apply(tr);

    const ids = blockIds(next.doc);
    expect(ids).toEqual(['t-1', 'p-1', 'p-2', 'p-3']); // every prior id preserved, in order
    expect(allUnique(ids)).toBe(true);
  });
});
