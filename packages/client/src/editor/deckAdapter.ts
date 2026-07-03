import type { Command, EditorState } from 'prosemirror-state';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { baseKeymap, deleteSelection, joinBackward } from 'prosemirror-commands';
import type { DeckContext, KeyActions } from '../deck/index.js';
import { unwrapFormulaBackspace, maybeWrapBoundaryFormula } from '../plugins/formula/index.js';
import type { FormulaRegistry } from '../plugins/formula/index.js';
import { runPreInsert } from './inputPipeline/index.js';
import type { TransformRegistry } from './inputPipeline/index.js';
import { linkifyTrailingUrl, unwrapLinkBackspace } from './autolink.js';
// Block-object chrome (Mechanic A): single-press inline-atom delete. The Deck bypasses the PM keymap, so the
// SAME command the keymap chains must be invoked here too ([[deck-keypad-bypasses-inputrules-keymap]]).
import { deleteInlineAtomBackspace } from './plugins/blockAtomChrome.js';

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
export function buildPmKeyActions(
  getView: () => EditorView | null,
  formulaRegistry: FormulaRegistry,
  inputTransforms?: TransformRegistry,
): KeyActions {
  const run = (fn: (v: EditorView) => void) => {
    const v = getView();
    if (!v) return;
    fn(v);
    v.focus();
  };
  return {
    insert: (text) => run((v) => {
      // [ROAD-0007] the unified pipeline's pre-insert runner: every registered insert transform (formula
      // '='-auto/'[...]'-bracket first, then markdown — registration order IS §5.4 order; autolink lands at
      // step 3) fires on the Deck through this ONE generic call — the per-feature dual-wire is dead.
      // Fired = the transform consumed the char; else plain insert.
      const sel = v.state.selection;
      if (inputTransforms && runPreInsert(v, sel.from, sel.to, text, inputTransforms.insert)) return;
      v.dispatch(v.state.tr.insertText(text));
    }),
    enter: () => run((v) => {
      // ENTER boundary on the keypad path (bypasses the keymap): a trailing token is either a FORMULA
      // (wrap → node) or a URL/bare-domain (linkify → link mark), not both — try formula first, else
      // autolink — THEN do the normal enter on the updated state.
      if (!maybeWrapBoundaryFormula(v.state, v.dispatch, formulaRegistry)) linkifyTrailingUrl(v.state, v.dispatch);
      (baseKeymap['Enter'] as Command)(v.state, v.dispatch, v);
    }),
    // Own the char-delete: baseKeymap.Backspace only joins at block boundaries (the native keyboard did
    // mid-text delete), and inputmode=none suppressed the native keyboard — so the keypad owns it.
    backspace: () => run((v) => {
      // Inline-formula: a backspace at a formula chip's right edge unwraps it to plain text first (the
      // custom keyboard bypasses the keymap, so the unwrap command is shared here too).
      if (unwrapFormulaBackspace(v.state, v.dispatch)) return;
      // Link (#74): a backspace at a linked run's right edge unwraps it to plain URL text (dual-wired here
      // for the Deck since it bypasses the keymap). Formula nodes vs link marks don't overlap → order safe.
      if (unwrapLinkBackspace(v.state, v.dispatch)) return;
      // Block-object (Mechanic A): a backspace right after a block-object atom (link card / attachment)
      // deletes it as ONE unit (single press) — the same guarded command the keymap chains, dual-wired here
      // since the Deck bypasses the keymap. Inert unless the caret flanks an inline atom, so normal char
      // delete below is untouched. (Formulas are content nodes, not atoms → handled by the unwrap above.)
      if (deleteInlineAtomBackspace(v.state, v.dispatch)) return;
      const { selection } = v.state;
      if (!selection.empty) { deleteSelection(v.state, v.dispatch); return; }
      if (selection.$from.parentOffset > 0) { v.dispatch(v.state.tr.delete(selection.from - 1, selection.from)); return; }
      joinBackward(v.state, v.dispatch, v);
    }),

    // §7.1 — double-space → ". ": when the caret sits right after "<letter|digit><space>", replace that
    // trailing space with a period+space (a new sentence). Anything else (sentence already ends in
    // punctuation, line start, a non-letter before the space) falls back to a plain space (the skip rule).
    sentenceSpace: () => run((v) => {
      // SPACE boundary on the keypad path (#74): re-link a trailing URL BEFORE the space — the space
      // autolink is an inputRules.ts rule, so it fires on hardware but NOT the Deck (Jim's primary path).
      // No char inserted; the already-linked guard prevents double-apply. Then the normal space logic runs
      // on the updated state.
      linkifyTrailingUrl(v.state, v.dispatch);
      const { selection } = v.state;
      if (!selection.empty) { v.dispatch(v.state.tr.insertText(' ')); return; }
      const $from = selection.$from;
      const off = $from.parentOffset;
      const prevTwo = $from.parent.textBetween(Math.max(0, off - 2), off);
      if (prevTwo.length === 2 && prevTwo[1] === ' ' && /[\p{L}\p{N}]/u.test(prevTwo[0]!)) {
        const from = selection.from;
        v.dispatch(v.state.tr.delete(from - 1, from).insertText('. '));
      } else {
        v.dispatch(v.state.tr.insertText(' '));
      }
    }),

    // §7.3 — should the NEXT letter auto-capitalize? True at a block start (doc start / after a newline)
    // and after a sentence terminator + space (". " / "! " / "? "). A pure query (no focus side-effect).
    shouldAutoCapitalize: () => {
      const v = getView();
      if (!v) return false;
      const { selection } = v.state;
      if (!selection.empty) return false;
      const $from = selection.$from;
      const off = $from.parentOffset;
      if (off === 0) return true; // block start = new line/paragraph = new sentence
      const before = $from.parent.textBetween(Math.max(0, off - 2), off);
      return /[.!?]\s$/.test(before);
    },

    // §7.4 — relative caret move from the space-trackpad. dx = char steps (±), dy = visual-line steps (±).
    // RELATIVE/delta-based (never an absolute posAtCoords jump): horizontal walks document positions;
    // vertical re-aims at the same x one line-height up/down per step via the view's coordinate mapping.
    moveCaret: (dx, dy) => run((v) => {
      const size = v.state.doc.content.size;
      let pos = Math.max(0, Math.min(size, v.state.selection.head + dx));
      let sel = TextSelection.near(v.state.doc.resolve(pos), dx >= 0 ? 1 : -1);
      if (dy !== 0) {
        const coords = v.coordsAtPos(sel.head);
        const lineH = Math.max(1, coords.bottom - coords.top);
        const targetY = (coords.top + coords.bottom) / 2 + dy * lineH;
        const found = v.posAtCoords({ left: coords.left, top: targetY });
        if (found) {
          pos = Math.max(0, Math.min(size, found.pos));
          sel = TextSelection.near(v.state.doc.resolve(pos));
        }
      }
      v.dispatch(v.state.tr.setSelection(sel).scrollIntoView());
    }),
  };
}
