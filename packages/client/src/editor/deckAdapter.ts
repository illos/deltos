import type { Command, EditorState } from 'prosemirror-state';
import { NodeSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { baseKeymap, deleteSelection, joinBackward } from 'prosemirror-commands';
import type { DeckContext, KeyActions } from '../deck/index.js';

/**
 * The deltos↔Deck ADAPTER (#69 §0.5). ALL ProseMirror-specific code lives here, never in Deck core: the
 * context derivation (PM selection → Deck context key) and the keypad's KeyActions (abstract key events →
 * PM transactions). This is the only file the boundary needs; extracting the Deck means deleting nothing
 * from core and rewriting only this adapter for a new host.
 */

/** Map the editor selection to a Deck context: a selected node → its type; a text caret/range → 'text'. */
export function deriveDeckContext(state: EditorState): DeckContext {
  const sel = state.selection;
  if (sel instanceof NodeSelection) return `node:${sel.node.type.name}`;
  return 'text';
}

/**
 * Wire the keypad's abstract KeyActions to ProseMirror. `getView` is read lazily so the actions are stable
 * across view re-creation. Each action runs against the live view and refocuses (focus is a host concern;
 * the keypad's pointerdown-preventDefault already keeps focus, this is belt).
 */
export function buildPmKeyActions(getView: () => EditorView | null): KeyActions {
  const run = (fn: (v: EditorView) => void) => {
    const v = getView();
    if (!v) return;
    fn(v);
    v.focus();
  };
  return {
    insert: (text) => run((v) => v.dispatch(v.state.tr.insertText(text))),
    enter: () => run((v) => { (baseKeymap['Enter'] as Command)(v.state, v.dispatch, v); }),
    // Own the char-delete: baseKeymap.Backspace only joins at block boundaries (the native keyboard did
    // mid-text delete), and inputmode=none suppressed the native keyboard — so the keypad owns it.
    backspace: () => run((v) => {
      const { selection } = v.state;
      if (!selection.empty) { deleteSelection(v.state, v.dispatch); return; }
      if (selection.$from.parentOffset > 0) { v.dispatch(v.state.tr.delete(selection.from - 1, selection.from)); return; }
      joinBackward(v.state, v.dispatch, v);
    }),
  };
}
