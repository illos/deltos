import type { Command } from 'prosemirror-state';
import { inputPipelineKey } from './key.js';

/**
 * Backspace-reverts-autoformat (design §5.1, decision D3): immediately after an insert transform fires
 * (`- ` → list, `**x**` → bold, URL+space → link), ONE Backspace restores the literal trigger text instead
 * of deleting into the converted structure. prosemirror-inputrules' `undoInputRule` recipe against the
 * pipeline's own record: invert the recorded transform's steps, then re-insert the consumed trigger text.
 * The record clears on any other selection/doc change (plugin.ts state.apply), so the revert window is
 * exactly "right after the conversion" — a second Backspace deletes normally.
 *
 * Registered FIRST in the backspace edit chain — consumed by BOTH keyboards (keymap + deckAdapter), which
 * is what `undoInputRule` alone could never do ([[deck-keypad-bypasses-inputrules-keymap]]).
 */
export const undoLastTransform: Command = (state, dispatch) => {
  const record = inputPipelineKey.getState(state);
  if (!record) return false;
  if (dispatch) {
    const tr = state.tr;
    const toUndo = record.transform;
    try {
      for (let j = toUndo.steps.length - 1; j >= 0; j--) tr.step(toUndo.steps[j]!.invert(toUndo.docs[j]!));
    } catch {
      // A follow-up transaction (e.g. a blockId attr re-mint) made the inverse unappliable — treat the
      // revert window as closed rather than corrupting the doc; fall through to the normal chain.
      return false;
    }
    if (record.text) {
      const marks = tr.doc.resolve(record.from).marks();
      tr.replaceWith(record.from, record.to, state.schema.text(record.text, marks));
    } else {
      tr.delete(record.from, record.to);
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};
