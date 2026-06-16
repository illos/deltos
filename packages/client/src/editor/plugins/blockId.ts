import { Plugin } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import { newBlockId } from '../../lib/ids.js';

/**
 * Unique block ID plugin. The spine is ID-first: every block carries a stable UUID that
 * identifies it for sync, collab (PM Steps → DO mapping), and per-block history.
 *
 * ProseMirror does NOT preserve node IDs across copy/paste, split, or merge for free:
 *  - Paste: the pasted subtree arrives with IDs from the source, creating duplicates.
 *  - Split (Enter in a paragraph): the new node inherits the old node's attrs including id.
 *  - Merge (Backspace at start): one node absorbs the other; the surviving id is arbitrary.
 *
 * This plugin runs as appendTransaction on every doc-changing transaction and:
 *  1. Mints a fresh id on any node that lacks one (newly inserted nodes).
 *  2. Re-mints ids that appear more than once — but PRESERVES the PRIOR OWNER and only
 *     re-mints the copies (paste/split duplicates). Prior owner = which occurrence maps
 *     back to the node's position in oldState. This upholds the spine ID-first invariant:
 *     existing block IDs never silently change, only newly-inserted copies get fresh IDs.
 *  3. Leaves unique ids untouched (move, reorder, formatting — preserve the id).
 *
 * The plugin never changes the document's content or structure, only node attrs — so it
 * cannot create an infinite loop.
 */

const ID_NODE_TYPES = new Set([
  'title',
  'paragraph',
  'heading',
  'blockquote',
  'code_block',
  'todo_item',
  'horizontal_rule',
  'bullet_list',
  'ordered_list',
  'list_item',
  'plugin_block',
]);

export const uniqueBlockIdPlugin = new Plugin({
  appendTransaction(transactions, oldState, newState) {
    const docChanged = transactions.some((tr) => tr.docChanged);
    if (!docChanged) return null;

    // ── Step 1: Map prior owners forward ──────────────────────────────────────
    // Build id → position from oldState, then map each position through the
    // transaction chain so we know where the prior owner landed in newState.
    // This is what lets us distinguish the original from a pasted copy.
    const oldIdToPos = new Map<string, number>();
    oldState.doc.descendants((node, pos) => {
      if (!ID_NODE_TYPES.has(node.type.name)) return;
      const id = node.attrs.id as string | null;
      if (id) oldIdToPos.set(id, pos);
    });

    const oldIdToMappedPos = new Map<string, number>();
    for (const [id, oldPos] of oldIdToPos) {
      let pos = oldPos;
      for (const tr of transactions as Transaction[]) {
        pos = tr.mapping.map(pos);
      }
      oldIdToMappedPos.set(id, pos);
    }

    // ── Step 2: Collect all positions for each id in the new doc ──────────────
    const idToPositions = new Map<string, number[]>();
    const nullPositions: number[] = [];
    newState.doc.descendants((node, pos) => {
      if (!ID_NODE_TYPES.has(node.type.name)) return;
      const id = node.attrs.id as string | null;
      if (!id) {
        nullPositions.push(pos);
      } else {
        const arr = idToPositions.get(id);
        if (arr) arr.push(pos);
        else idToPositions.set(id, [pos]);
      }
    });

    const patchTr = newState.tr;
    let patched = false;

    // ── Step 3: Mint fresh IDs for null-id nodes (new nodes from split/insert) ─
    for (const pos of nullPositions) {
      const node = newState.doc.nodeAt(pos);
      if (!node) continue;
      patchTr.setNodeMarkup(pos, undefined, { ...node.attrs, id: newBlockId() });
      patched = true;
    }

    // ── Step 4: For duplicated IDs, keep the prior owner and re-mint copies ───
    // Prior owner = the occurrence whose position is closest to where the old
    // node mapped to in newState. All other occurrences are paste copies.
    for (const [id, positions] of idToPositions) {
      if (positions.length <= 1) continue;

      const mappedOldPos = oldIdToMappedPos.get(id);
      const keepPos =
        mappedOldPos !== undefined
          ? positions.reduce((best, p) =>
              Math.abs(p - mappedOldPos) < Math.abs(best - mappedOldPos) ? p : best,
            positions[0]!)
          : positions[0]!; // No prior record (shouldn't happen) — keep first

      for (const pos of positions) {
        if (pos === keepPos) continue;
        const node = newState.doc.nodeAt(pos);
        if (!node) continue;
        patchTr.setNodeMarkup(pos, undefined, { ...node.attrs, id: newBlockId() });
        patched = true;
      }
    }

    return patched ? patchTr : null;
  },
});
