/**
 * SPIKE (block-object-chrome, Mechanic A) — caret "delete-as-one-character" for the inline-atom plugin_block.
 *
 * Re-modelling plugin_block from a BLOCK atom to an INLINE atom (schema.ts) buys caret POSITIONING for free:
 * the caret sits immediately before AND after the object, and ArrowLeft/Right step across it one position
 * (an inline atom has nodeSize 1). But DELETION is not free — ProseMirror's base Backspace/Delete chain
 * (joinBackward / selectNodeBackward …) gives a "select the atom first, press again to delete" UX for atoms,
 * not the single-press char delete the user wants. These two tiny commands restore single-press semantics:
 * caret directly after the atom + Backspace → delete it as one unit; caret directly before + Delete → same.
 *
 * They live in the LAZY editor chunk (imported by the editor, never by the mobile first-load / list bundle),
 * satisfying the perf gate. They mirror unwrapFormulaBackspace exactly, so the two object systems read alike.
 */
import type { Command } from 'prosemirror-state';

/** Backspace at the RIGHT edge of an inline atom → delete it as ONE unit (single press). */
export const deleteInlineAtomBackspace: Command = (state, dispatch): boolean => {
  if (!state.selection.empty) return false;
  const pos = state.selection.from;
  const before = state.doc.resolve(pos).nodeBefore;
  // NB: a TEXT node is also isAtom+isInline (it's a leaf) — exclude it or this would eat plain characters.
  if (!before || before.isText || !before.type.isAtom || !before.isInline) return false;
  if (dispatch) dispatch(state.tr.delete(pos - before.nodeSize, pos).scrollIntoView());
  return true;
};

/** Forward-Delete at the LEFT edge of an inline atom → delete it as ONE unit (symmetric). */
export const deleteInlineAtomDelete: Command = (state, dispatch): boolean => {
  if (!state.selection.empty) return false;
  const pos = state.selection.from;
  const after = state.doc.resolve(pos).nodeAfter;
  if (!after || after.isText || !after.type.isAtom || !after.isInline) return false;
  if (dispatch) dispatch(state.tr.delete(pos, pos + after.nodeSize).scrollIntoView());
  return true;
};
