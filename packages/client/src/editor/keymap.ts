import {
  baseKeymap,
  toggleMark,
  setBlockType,
  wrapIn,
  chainCommands,
  exitCode,
  newlineInCode,
  createParagraphNear,
  liftEmptyBlock,
  splitBlock,
} from 'prosemirror-commands';
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import type { Command } from 'prosemirror-state';
import type { DeltoSchema } from './schema.js';
import { toggleMarkCmd, linkCommand } from './commands.js';
import { compileEditChain } from './inputPipeline/index.js';
import type { TransformRegistry } from './inputPipeline/index.js';
// SPIKE (block-object-chrome, Mechanic A): single-press delete for the inline-atom plugin_block.
import { deleteInlineAtomBackspace, deleteInlineAtomDelete } from './plugins/blockAtomChrome.js';

/**
 * Keyboard bindings for the deltos editor. Keeps standard editing muscle-memory intact
 * (bold, italic, code, lists, heading levels, undo/redo) while integrating with the
 * PM command model so every mutation goes through a Transaction (trackable by plugins).
 */

/**
 * Enter inside the `title` node: split into title-before + new paragraph-after.
 * This is what makes "Enter from title → body" work as a single PM document.
 *
 * chainCommands tries this first; if the cursor isn't in the title it returns false
 * and the next handler in the chain takes over (splitListItem, then the base handlers).
 */
const titleEnter: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.name !== 'title') return false;
  if (!dispatch) return true;

  const paragraphType = state.schema.nodes['paragraph']!;
  const tr = state.tr;
  // Delete any selected text first, then split at the cursor.
  if (!state.selection.empty) tr.deleteSelection();
  tr.split(tr.selection.$from.pos, 1, [{ type: paragraphType, attrs: { id: null } }]);
  tr.scrollIntoView();
  dispatch(tr);
  return true;
};

/**
 * Enter on a `todo_item`: continue the checklist — split into item-before + a NEW UNCHECKED item after
 * (checked never carries over; ticking one box must not pre-tick the next), exactly like Enter in a list
 * item continues the list (Jim, 2026-07-03 — the Deck shipped without ANY of this; the shared chain gives
 * it to both keyboards). An EMPTY todo item exits the checklist instead: it becomes a paragraph (the
 * standard empty-list-item lift, adapted — todo_item is a flat block, not a list_item).
 *
 * Without this command, splitBlock did the work: mid-item it copied the attrs (a CHECKED todo spawned
 * another checked one) and at the end of an item it produced a paragraph (checklist dead-ended) — so
 * native gets fixed by this too, not just the Deck.
 */
export const splitTodoItem: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.name !== 'todo_item') return false;
  const todo = state.schema.nodes['todo_item']!;
  const paragraph = state.schema.nodes['paragraph']!;
  if ($from.parent.content.size === 0) {
    // Empty item + Enter = exit the checklist: convert in place (id preserved, type-change semantics).
    if (dispatch) {
      const pos = $from.before();
      dispatch(state.tr.setNodeMarkup(pos, paragraph, { id: $from.parent.attrs.id }).scrollIntoView());
    }
    return true;
  }
  if (dispatch) {
    const tr = state.tr;
    if (!state.selection.empty) tr.deleteSelection();
    // id:null → uniqueBlockIdPlugin mints a fresh id for the new item (never duplicate the split id).
    tr.split(tr.selection.$from.pos, 1, [{ type: todo, attrs: { id: null, checked: false } }]);
    tr.scrollIntoView();
    dispatch(tr);
  }
  return true;
};

/**
 * The ONE Enter command BOTH keyboards consume (design §3.4; D5 resolved 2026-07-03 — the Deck ran only
 * `baseKeymap.Enter`, so Enter inside a list item did NOTHING on the Deck): the pipeline's Enter-boundary
 * transforms first (formula-wrap, then linkify — first-true wins, they're mutually exclusive), THEN the
 * structural chain on the post-boundary state. The boundary leg needs the live view to read the updated
 * state (both real surfaces have one); headless/dry-run calls skip it.
 */
export function buildEnterChain(schema: DeltoSchema, transforms?: TransformRegistry): Command {
  const { nodes } = schema;
  const structural = chainCommands(
    titleEnter,
    splitTodoItem,
    ...(nodes['list_item'] ? [splitListItem(nodes['list_item'])] : []),
    newlineInCode,
    createParagraphNear,
    liftEmptyBlock,
    splitBlock,
  );
  if (!transforms) return structural;
  return (state, dispatch, view) => {
    if (dispatch && view) {
      for (const t of transforms.enterBoundary) {
        if (t.cmd(view.state, view.dispatch, view)) break;
      }
      return structural(view.state, view.dispatch, view);
    }
    return structural(state, dispatch, view);
  };
}

export function buildKeymap(schema: DeltoSchema, transforms?: TransformRegistry) {
  const { nodes, marks } = schema;
  const bindings: Record<string, Command> = {};

  // Undo / redo
  bindings['Mod-z'] = undo;
  bindings['Mod-y'] = redo;
  bindings['Mod-Shift-z'] = redo;

  // Inline marks (the new bindings route through the shared commands.ts builders so a shortcut, a
  // toolbar tap, and a markdown trigger that mean the same thing run the same command).
  if (marks['bold'])   bindings['Mod-b'] = toggleMark(marks['bold']);
  if (marks['italic']) bindings['Mod-i'] = toggleMark(marks['italic']);
  if (marks['code'])   bindings['Mod-`'] = toggleMark(marks['code']);
  if (marks['underline'])     bindings['Mod-u'] = toggleMarkCmd(schema, 'underline');
  if (marks['strikethrough']) bindings['Mod-Shift-x'] = toggleMarkCmd(schema, 'strikethrough'); // GitHub/Notion convention
  if (marks['highlight'])     bindings['Mod-Shift-h'] = toggleMarkCmd(schema, 'highlight');
  if (marks['link'])          bindings['Mod-k'] = linkCommand(schema); // prompts on a non-empty selection

  // Headings
  if (nodes['heading']) {
    for (let level = 1; level <= 6; level++) {
      bindings[`Mod-Alt-${level}`] = setBlockType(nodes['heading'], { level });
    }
  }

  // Back to paragraph
  if (nodes['paragraph']) {
    bindings['Mod-Alt-0'] = setBlockType(nodes['paragraph']);
  }

  // Code block
  if (nodes['code_block']) {
    bindings['Mod-Alt-c'] = setBlockType(nodes['code_block']);
  }

  // Blockquote
  if (nodes['blockquote']) {
    bindings['Mod-Shift->'] = wrapIn(nodes['blockquote']);
  }

  // Hard break (Shift-Enter in non-code blocks)
  if (nodes['hard_break']) {
    const insertHardBreak = chainCommands(exitCode, (state, dispatch) => {
      if (!dispatch) return true;
      dispatch(state.tr.replaceSelectionWith(nodes['hard_break']!.create()).scrollIntoView());
      return true;
    });
    bindings['Shift-Enter'] = insertHardBreak;
  }

  // Enter: boundary transforms → title → todo → list item → code newline → default block split. ONE
  // compiled chain shared with the deckAdapter (design §3.4) — the full structural chain is required here
  // because buildKeymap overrides baseKeymap's Enter; without the base handlers, regular paragraph Enter
  // would fall through to browser-native contenteditable behaviour (unmanaged DOM mutation).
  bindings['Enter'] = buildEnterChain(schema, transforms);

  // Backspace/Delete: the pipeline's compiled edit chains (D3 revert → formula-unwrap → link-unwrap →
  // atom-delete; registration order is the chain order) ahead of the base handlers — the SAME chains the
  // deckAdapter consumes. The no-transforms fallback keeps the old atom-only wiring (legacy/test callers).
  bindings['Backspace'] = chainCommands(
    transforms ? compileEditChain(transforms.backspace) : deleteInlineAtomBackspace,
    baseKeymap['Backspace']!,
  );
  bindings['Delete'] = chainCommands(
    transforms ? compileEditChain(transforms.forwardDelete) : deleteInlineAtomDelete,
    baseKeymap['Delete']!,
  );

  // List indentation
  if (nodes['list_item']) {
    bindings['Tab']       = sinkListItem(nodes['list_item']);
    bindings['Shift-Tab'] = liftListItem(nodes['list_item']);
  }

  return bindings;
}

export function buildKeymapPlugin(schema: DeltoSchema, transforms?: TransformRegistry) {
  return keymap({ ...baseKeymap, ...buildKeymap(schema, transforms) });
}
