import { toggleMark, wrapIn, lift } from 'prosemirror-commands';
import { wrapInList, liftListItem } from 'prosemirror-schema-list';
import type { Command } from 'prosemirror-state';
import type { DeltoSchema } from './schema.js';

/**
 * ONE shared command layer for the editor. The desktop toolbar, the mobile grouped bar, the keymap,
 * and (future) a tool-descriptor registry all dispatch THROUGH these builders — so a markdown input
 * rule, a toolbar click, and a keyboard shortcut that mean "make this a heading" route through the
 * exact same command. No command logic is duplicated in any surface. Each builder is individually
 * referenceable (registry-ready); `commandFor(schema, id)` is the by-id dispatcher the bars use.
 *
 * UI `data-cmd` ids (the stable surface ids) → schema:
 *   marks:  bold·italic·underline·strike(→strikethrough)·mark(→highlight)·code·link
 *   blocks: h1·h2·h3·p·pre   lists: ul·ol·check   insert: quote·divider·link
 *   (image is intentionally absent — embeds are deferred to a future attachment plugin.)
 */

const MARK_FOR: Record<string, string> = {
  bold: 'bold', italic: 'italic', underline: 'underline',
  strike: 'strikethrough', mark: 'highlight', code: 'code',
};

const BLOCK_FOR: Record<string, { node: string; attrs?: Record<string, unknown> }> = {
  h1: { node: 'heading', attrs: { level: 1 } },
  h2: { node: 'heading', attrs: { level: 2 } },
  h3: { node: 'heading', attrs: { level: 3 } },
  p:  { node: 'paragraph' },
  pre: { node: 'code_block' },
};

const NOOP: Command = () => false;

/** Toggle an inline mark by schema name. Thin wrapper over prosemirror-commands toggleMark. */
export function toggleMarkCmd(schema: DeltoSchema, markName: string): Command {
  const m = schema.marks[markName];
  return m ? toggleMark(m) : NOOP;
}

/**
 * Set the selected textblock(s) to `nodeName` — id-PRESERVING (the installed setBlockType resets
 * attrs to defaults, which would re-mint the block id; the spine is id-first so type changes must
 * keep the id). Converting TO a code block strips inline marks the code block disallows. The unified
 * `title` node is never converted (keeps the extractTitleFromDoc invariant — see schema `doc`).
 */
export function setBlock(schema: DeltoSchema, nodeName: string, attrs: Record<string, unknown> = {}): Command {
  const type = schema.nodes[nodeName];
  return (state, dispatch) => {
    if (!type) return false;
    const { from, to } = state.selection;
    const targets: number[] = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock || node.type.name === 'title') return;
      if (!node.hasMarkup(type, { ...node.attrs, ...attrs })) targets.push(pos);
    });
    if (targets.length === 0) return false;
    if (dispatch) {
      const tr = state.tr; // removeMark + setNodeMarkup are size-preserving, so positions stay valid
      for (const pos of targets) {
        const node = tr.doc.nodeAt(pos);
        if (!node) continue;
        // A code block disallows inline marks — strip them BEFORE the type change, else setNodeMarkup
        // rejects the (still-marked) content as invalid for code_block.
        if (type.spec.code) {
          const start = pos + 1, end = pos + 1 + node.content.size;
          for (const name of Object.keys(schema.marks)) tr.removeMark(start, end, schema.marks[name]);
        }
        tr.setNodeMarkup(pos, type, { ...node.attrs, ...attrs, id: node.attrs.id });
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Toggle a wrapping block (quote): if already inside one, lift out; else wrap. */
export function toggleWrap(schema: DeltoSchema, nodeName: string): Command {
  const type = schema.nodes[nodeName];
  return (state, dispatch, view) => {
    if (!type) return false;
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === type) return lift(state, dispatch);
    }
    return wrapIn(type)(state, dispatch, view);
  };
}

/** Toggle a list of `listNodeName` (bullet/ordered): if already in that list type, lift; else wrap. */
export function toggleList(schema: DeltoSchema, listNodeName: string): Command {
  const listType = schema.nodes[listNodeName];
  const itemType = schema.nodes['list_item'];
  return (state, dispatch, view) => {
    if (!listType || !itemType) return false;
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === listType) return liftListItem(itemType)(state, dispatch, view);
    }
    return wrapInList(listType)(state, dispatch, view);
  };
}

/** Toggle the current textblock between paragraph and todo_item (checklist), id-preserving. */
export function toggleTodo(schema: DeltoSchema): Command {
  return (state, dispatch, view) => {
    const isTodo = state.selection.$from.parent.type === schema.nodes['todo_item'];
    return isTodo
      ? setBlock(schema, 'paragraph')(state, dispatch, view)
      : setBlock(schema, 'todo_item', { checked: false })(state, dispatch, view);
  };
}

/** Insert a horizontal rule (divider) at the selection. */
export function insertHorizontalRule(schema: DeltoSchema): Command {
  const hr = schema.nodes['horizontal_rule'];
  return (state, dispatch) => {
    if (!hr) return false;
    if (dispatch) dispatch(state.tr.replaceSelectionWith(hr.create()).scrollIntoView());
    return true;
  };
}

/** Apply a link mark with `href` over the (non-empty) selection. */
export function setLink(schema: DeltoSchema, href: string): Command {
  const linkType = schema.marks['link'];
  return (state, dispatch) => {
    if (!linkType) return false;
    const { from, to, empty } = state.selection;
    if (empty) return false;
    if (dispatch) dispatch(state.tr.addMark(from, to, linkType.create({ href, title: null })));
    return true;
  };
}

/** Remove the link mark from the selection. */
export function unsetLink(schema: DeltoSchema): Command {
  const linkType = schema.marks['link'];
  return (state, dispatch) => {
    if (!linkType) return false;
    const { from, to, empty } = state.selection;
    if (empty) return false;
    if (dispatch) dispatch(state.tr.removeMark(from, to, linkType));
    return true;
  };
}

/**
 * Link UI command (v1): on a non-empty selection that already has a link, toggle it off; otherwise
 * window.prompt for a URL and apply it. The polished inline popover is a later refinement (spec §2).
 */
export function linkCommand(schema: DeltoSchema): Command {
  const linkType = schema.marks['link'];
  return (state, dispatch, view) => {
    if (!linkType) return false;
    const { from, to, empty } = state.selection;
    if (empty) return false;
    if (state.doc.rangeHasMark(from, to, linkType)) return unsetLink(schema)(state, dispatch, view);
    const href = typeof window !== 'undefined' ? window.prompt('Link URL')?.trim() : null;
    if (!href) return false;
    return setLink(schema, href)(state, dispatch, view);
  };
}

/** By-id dispatcher: maps a UI `data-cmd` to its shared command. Used by both bars + the registry. */
export function commandFor(schema: DeltoSchema, cmdId: string): Command {
  if (cmdId in MARK_FOR) return toggleMarkCmd(schema, MARK_FOR[cmdId]!);
  if (cmdId in BLOCK_FOR) { const b = BLOCK_FOR[cmdId]!; return setBlock(schema, b.node, b.attrs ?? {}); }
  switch (cmdId) {
    case 'ul':      return toggleList(schema, 'bullet_list');
    case 'ol':      return toggleList(schema, 'ordered_list');
    case 'check':   return toggleTodo(schema);
    case 'quote':   return toggleWrap(schema, 'blockquote');
    case 'divider': return insertHorizontalRule(schema);
    case 'link':    return linkCommand(schema);
    default:        return NOOP;
  }
}
