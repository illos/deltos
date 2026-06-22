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

export function buildKeymap(schema: DeltoSchema) {
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

  // Enter: title → body → list item → code newline → default block split.
  // The full chain is required here because buildKeymap overrides baseKeymap's Enter;
  // without explicitly including the base handlers, regular paragraph Enter would fall
  // through to browser-native contenteditable behaviour (unmanaged DOM mutation).
  bindings['Enter'] = chainCommands(
    titleEnter,
    ...(nodes['list_item'] ? [splitListItem(nodes['list_item'])] : []),
    newlineInCode,
    createParagraphNear,
    liftEmptyBlock,
    splitBlock,
  );

  // List indentation
  if (nodes['list_item']) {
    bindings['Tab']       = sinkListItem(nodes['list_item']);
    bindings['Shift-Tab'] = liftListItem(nodes['list_item']);
  }

  return bindings;
}

export function buildKeymapPlugin(schema: DeltoSchema) {
  return keymap({ ...baseKeymap, ...buildKeymap(schema) });
}
