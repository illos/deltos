import { Plugin } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import type { Node as PmNode } from 'prosemirror-model';
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

/**
 * RENDER-ONLY inner node: the list_item's inner paragraph/todo_item. pmDocToSpine keys a list block-child on
 * the list_item's id and DISCARDS this inner node's id, so it is never persisted. spineToPmDoc emits `id: null`
 * here; the plugin both refuses to MINT one AND STRIPS any stray id (e.g. a top-level block dragged INTO a
 * list, or a split copying an id) so the live doc converges on the deterministic id-less shape.
 */
function isRenderOnlyInner(node: PmNode, parent: PmNode | null): boolean {
  return (
    (node.type.name === 'paragraph' || node.type.name === 'todo_item') &&
    parent?.type.name === 'list_item'
  );
}

/**
 * MANAGED: the plugin mints/dedupes the id (it backs the spine block). Everything else is ignored. Two render-
 * only exclusions, both because their id is NOT round-tripped into the spine and a minted/random one defeats
 * the #90 reconcile echo-guard (incoming.eq(doc)) — wiping the undo stack on every autosave:
 *   • the `title` node — pmDocToSpine skips it entirely (title travels as a separate string). It is seeded
 *     id-less and we never mint one, so it stays null and matches spineToPmDoc's null. (We don't STRIP it: a
 *     title can't be duplicated and an explicitly-id'd title in fixtures should be left as-is.)
 *   • a list_item's inner paragraph/todo_item — see isRenderOnlyInner (those are stripped to null).
 */
function isManaged(node: PmNode, parent: PmNode | null): boolean {
  if (!ID_NODE_TYPES.has(node.type.name)) return false;
  if (node.type.name === 'title') return false;
  if (isRenderOnlyInner(node, parent)) return false;
  return true;
}

/**
 * ORPHANED render-only id: a managed node still carrying a synthetic wrapper id (`…~w` / `…~q` / `…~empty`)
 * that spineToPmDoc mints for a plugin-atom wrapper paragraph, a blockquote's first paragraph, or an empty
 * list's fallback item — but whose wrapper STRUCTURE is gone (its atom / blockquote / list was deleted, or the
 * node gained siblings/content). pmDocToSpine re-mints such an id at the PERSIST boundary (sanitizeBlockIds),
 * so if the LIVE doc keeps it, the saved spine's id diverges from the live doc's → the #90 reconcile echo-guard
 * (`incoming.eq(doc)`) fails → a full-doc replace with addToHistory:false WIPES the undo stack. That is the
 * delete-an-image-then-undo regression: deleting the inline atom leaves its `${atomId}~w` wrapper paragraph
 * behind, empty, still bearing the synthetic id. Stripping it here routes it to Step 3, which re-mints a clean
 * UUID in the LIVE doc → live == persisted → the guard short-circuits → history survives.
 *
 * Real UUIDs never contain `~`, so a `~` is an unambiguous synthetic marker. A STILL-VALID wrapper is matched
 * by STRUCTURE (not id-equality) so a paste-re-minted atom can't falsely orphan its own wrapper.
 */
function isOrphanedRenderOnlyId(node: PmNode, parent: PmNode | null, index: number): boolean {
  const id = node.attrs.id;
  if (typeof id !== 'string' || !id.includes('~')) return false; // clean UUID (or null) → not synthetic
  if (id.endsWith('~w')) {
    // valid: a paragraph wrapping exactly one inline plugin_block atom (spineToPmDoc's isolated-atom wrapper)
    return !(node.type.name === 'paragraph' && node.childCount === 1 && node.firstChild?.type.name === 'plugin_block');
  }
  if (id.endsWith('~q')) {
    // valid: the FIRST paragraph inside a blockquote (render-only; its id is derived, never persisted)
    return !(node.type.name === 'paragraph' && parent?.type.name === 'blockquote' && index === 0);
  }
  if (id.endsWith('~empty')) {
    // valid: the sole list_item of an (otherwise empty) list — the empty-list fallback item
    return !(
      node.type.name === 'list_item' &&
      (parent?.type.name === 'bullet_list' || parent?.type.name === 'ordered_list') &&
      parent.childCount === 1
    );
  }
  return true; // a `~`-bearing managed id with no recognised suffix is malformed → re-mint a clean one
}

export const uniqueBlockIdPlugin = new Plugin({
  appendTransaction(transactions, oldState, newState) {
    const docChanged = transactions.some((tr) => tr.docChanged);
    if (!docChanged) return null;

    // ── Step 1: Map prior owners forward ──────────────────────────────────────
    // Build id → position from oldState, then map each position through the
    // transaction chain so we know where the prior owner landed in newState.
    // This is what lets us distinguish the original from a pasted copy.
    const oldIdToPos = new Map<string, number>();
    oldState.doc.descendants((node, pos, parent) => {
      if (!isManaged(node, parent)) return;
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
    const strayIdPositions: number[] = []; // unmanaged (list-inner) nodes that carry a stray id → null it out
    newState.doc.descendants((node, pos, parent, index) => {
      if (!isManaged(node, parent)) {
        // List-inner nodes must stay id-less so spineToPmDoc round-trips deterministically. (The title is also
        // unmanaged but is intentionally left untouched — see isManaged.)
        if (isRenderOnlyInner(node, parent) && node.attrs.id) strayIdPositions.push(pos);
        return;
      }
      const id = node.attrs.id as string | null;
      if (!id) {
        nullPositions.push(pos);
      } else if (isOrphanedRenderOnlyId(node, parent, index)) {
        // A synthetic wrapper id left behind after its atom/quote/list was deleted (e.g. deleting an inline
        // image orphans its `${atomId}~w` paragraph). Route it to Step 3 like a null id → a clean UUID is
        // minted in the LIVE doc so it matches what pmDocToSpine persists, keeping the #90 reconcile guard
        // from replacing the doc and wiping undo. See isOrphanedRenderOnlyId.
        nullPositions.push(pos);
      } else {
        const arr = idToPositions.get(id);
        if (arr) arr.push(pos);
        else idToPositions.set(id, [pos]);
      }
    });

    const patchTr = newState.tr;
    let patched = false;

    // ── Step 0: Strip stray ids off render-only inner nodes (converge to the deterministic id-less shape) ─
    for (const pos of strayIdPositions) {
      const node = newState.doc.nodeAt(pos);
      if (!node) continue;
      patchTr.setNodeMarkup(pos, undefined, { ...node.attrs, id: null });
      patched = true;
    }

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
