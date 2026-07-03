import type { EditorState, Transaction } from 'prosemirror-state';
import type { ResolvedPos } from 'prosemirror-model';
import { inputPipelineKey } from './key.js';
import type { InsertTransform } from './registry.js';

/**
 * The ONE runner (design §3.2), in the two shapes the surfaces need. Both replicate
 * prosemirror-inputrules@1.5.1 `run()` semantics exactly — composing guard, MAX_MATCH-bounded
 * textblock-scoped textBefore (leaf nodes as U+FFFC), inCode/inCodeMark zone rules, first-non-null-tr
 * wins — so migrated rules behave bit-for-bit as they did under `inputRules({rules})`.
 */

/** prosemirror-inputrules parity: never match against more than this much text before the caret. */
export const MAX_MATCH = 500;

/** The slice of EditorView the pre-insert runner needs (tests drive it with a minimal double). */
export interface RunnerView {
  state: EditorState;
  dispatch: (tr: Transaction) => void;
  composing?: boolean;
}

/** Code-ZONE guards shared by both shapes (reference run() steps, same order/logic). */
function skipsCodeZone(t: InsertTransform, $from: ResolvedPos): boolean {
  const inCodeMark = t.inCodeMark ?? true;
  if (!inCodeMark && $from.marks().some((m) => m.type.spec.code)) return true;
  if ($from.parent.type.spec.code) {
    if (!t.inCode) return true;
  } else if (t.inCode === 'only') {
    return true;
  }
  return false;
}

/** Reference run()'s post-match re-check: no code MARK anywhere inside the matched span. */
function spanHasCodeMark(state: EditorState, from: number, to: number): boolean {
  let has = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isInline && node.marks.some((m) => m.type.spec.code)) has = true;
  });
  return has;
}

/**
 * PRE-INSERT shape — the trigger char is prospective (not yet in the doc). Used by native
 * `handleTextInput` (bit-identical to prosemirror-inputrules) and by `deckAdapter.insert` (the Deck's
 * generic call — one line replaces all per-feature dual-wiring). Dispatches the winning transform's tr
 * (which consumes the trigger by never inserting it) and returns true; false = caller inserts normally.
 */
export function runPreInsert(
  view: RunnerView,
  from: number,
  to: number,
  text: string,
  transforms: readonly InsertTransform[],
): boolean {
  if (view.composing) return false;
  const state = view.state;
  const $from = state.doc.resolve(from);
  if (!$from.parent.isTextblock) return false;
  const textBefore =
    $from.parent.textBetween(Math.max(0, $from.parentOffset - MAX_MATCH), $from.parentOffset, null, '￼') +
    text;
  for (const t of transforms) {
    if (skipsCodeZone(t, $from)) continue;
    const match = t.match.exec(textBefore);
    if (!match || match[0].length < text.length) continue;
    const startPos = from - (match[0].length - text.length);
    if (!(t.inCodeMark ?? true) && spanHasCodeMark(state, startPos, $from.pos)) continue;
    const tr = t.handler(state, match, startPos, to);
    if (!tr) continue;
    // Record for the backspace-revert command (D3) — same recipe as prosemirror-inputrules' plugin state.
    if (t.undoable ?? true) tr.setMeta(inputPipelineKey, { transform: tr, from, to, text });
    view.dispatch(tr);
    return true;
  }
  return false;
}

/**
 * POST-INSERT shape — the trigger text is already IN the doc (a tagged Deck/paste transaction observed
 * from `appendTransaction`). Anchors at the caret ($head of the post-apply state; requires an empty
 * selection sitting at the end of the inserted text — true by construction for single-char tagged
 * inserts). The matched span [startPos, caret] INCLUDES the trigger char; every registered handler
 * already consumes whatever [start, end] spans (§3.2 audit), so the same definitions serve both shapes.
 * Returns the transform's tr (built on `state`, to be returned from appendTransaction) or null.
 */
export function runPostInsert(
  state: EditorState,
  insertedText: string,
  transforms: readonly InsertTransform[],
): Transaction | null {
  const sel = state.selection;
  if (!sel.empty) return null;
  const $head = sel.$head;
  if (!$head.parent.isTextblock) return null;
  const caret = $head.pos;
  const textBefore = $head.parent.textBetween(
    Math.max(0, $head.parentOffset - MAX_MATCH),
    $head.parentOffset,
    null,
    '￼',
  );
  for (const t of transforms) {
    if (skipsCodeZone(t, $head)) continue;
    const match = t.match.exec(textBefore);
    if (!match || match[0].length < insertedText.length) continue;
    const startPos = caret - match[0].length;
    if (!(t.inCodeMark ?? true) && spanHasCodeMark(state, startPos, caret)) continue;
    const tr = t.handler(state, match, startPos, caret);
    if (tr) return tr;
  }
  return null;
}
