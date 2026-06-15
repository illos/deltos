import { baseKeymap, toggleMark, setBlockType, wrapIn, chainCommands, exitCode } from 'prosemirror-commands';
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import type { DeltoSchema } from './schema.js';

/**
 * Keyboard bindings for the deltos editor. Keeps standard editing muscle-memory intact
 * (bold, italic, code, lists, heading levels, undo/redo) while integrating with the
 * PM command model so every mutation goes through a Transaction (trackable by plugins).
 */
export function buildKeymap(schema: DeltoSchema) {
  const { nodes, marks } = schema;
  const bindings: Record<string, ReturnType<typeof toggleMark>> = {};

  // Undo / redo
  bindings['Mod-z'] = undo;
  bindings['Mod-y'] = redo;
  bindings['Mod-Shift-z'] = redo;

  // Inline marks
  if (marks['bold'])   bindings['Mod-b'] = toggleMark(marks['bold']);
  if (marks['italic']) bindings['Mod-i'] = toggleMark(marks['italic']);
  if (marks['code'])   bindings['Mod-`'] = toggleMark(marks['code']);

  // Headings (Mod-Alt-1 … Mod-Alt-3 covers the common cases)
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

  // Hard break (Shift-Enter in non-code blocks; plain Enter inside code)
  if (nodes['hard_break']) {
    const insertHardBreak = chainCommands(exitCode, (state, dispatch) => {
      if (!dispatch) return true;
      dispatch(state.tr.replaceSelectionWith(nodes['hard_break']!.create()).scrollIntoView());
      return true;
    });
    bindings['Shift-Enter'] = insertHardBreak;
  }

  // List item handling
  if (nodes['list_item']) {
    bindings['Enter']   = splitListItem(nodes['list_item']);
    bindings['Tab']     = sinkListItem(nodes['list_item']);
    bindings['Shift-Tab'] = liftListItem(nodes['list_item']);
  }

  return bindings;
}

export function buildKeymapPlugin(schema: DeltoSchema) {
  return keymap({ ...baseKeymap, ...buildKeymap(schema) });
}
