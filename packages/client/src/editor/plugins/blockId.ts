import { Plugin } from 'prosemirror-state';
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
 *  2. Re-mints ids that appear more than once in the document (paste/split duplicates).
 *  3. Leaves unique ids untouched (move, reorder, formatting — preserve the id).
 *
 * The plugin never changes the document's content or structure, only node attrs — so it
 * cannot create an infinite loop. Re-minting is deliberate: a duplicate ID would silently
 * corrupt the sync CAS check and the collab identity invariant.
 */

const ID_NODE_TYPES = new Set([
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
  appendTransaction(transactions, _oldState, newState) {
    const docChanged = transactions.some((tr) => tr.docChanged);
    if (!docChanged) return null;

    const tr = newState.tr;
    const seen = new Set<string>();
    let patched = false;

    newState.doc.descendants((node, pos) => {
      if (!ID_NODE_TYPES.has(node.type.name)) return;

      const currentId = node.attrs.id as string | null;

      if (!currentId || seen.has(currentId)) {
        // Missing or duplicate: re-mint. Duplicates arise from paste and split.
        const freshId = newBlockId();
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: freshId });
        seen.add(freshId);
        patched = true;
      } else {
        seen.add(currentId);
      }
    });

    return patched ? tr : null;
  },
});
