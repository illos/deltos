import type { Command, EditorState, Transaction } from 'prosemirror-state';
import type { Node as PmNode, Schema } from 'prosemirror-model';
import type { TransformRegistry } from '../../editor/inputPipeline/index.js';
import type { FormulaRegistry } from './formulaTypes.js';
import './formula.css';

/**
 * Inline-formula EDITOR PLUGINS (docs/specs/inline-formulas.md §1) — the two entry paths + the unwrap.
 * Wrapping builds a content-bearing `formula` NODE (spec = its text content); the type-dispatched NodeView
 * renders the output. Math is the first type; the logic is type-generic via the injected registry.
 *
 * ALL formula input behavior registers ONCE into the unified input pipeline via
 * {@link registerFormulaTransforms} ([ROAD-0007] steps 2+3): the INSERT triggers ('=' auto + '[...]'
 * bracket) AND the EDIT surface (backspace/Delete unwraps, the Enter boundary-wrap). Both keyboards
 * consume the compiled chains generically — the old per-feature dual-wire
 * ([[deck-keypad-bypasses-inputrules-keymap]]) is gone; this module owns no keymap plugin anymore.
 */

/** Build a formula node carrying `spec` as its editable text content (empty content is invalid → omitted). */
function formulaNode(schema: Schema, ftype: string, spec: string): PmNode {
  const formula = schema.nodes['formula']!;
  return formula.create({ ftype, state: null }, spec.length > 0 ? schema.text(spec) : null);
}

/** The framework is inert on a schema without the `formula` node (e.g. a minimal editor schema). */
function hasFormulaNode(schema: Schema): boolean {
  return !!schema.nodes['formula'];
}

/**
 * AUTO path (e.g. math '='): if the text before `boundary` ends in a run THIS registry auto-detects,
 * replace that run with a formula node + clear `[runEnd, deleteEnd)` (the trigger char + any space). For
 * the input rule, boundary = the trigger-char position, deleteEnd = after it; for the keypad path,
 * boundary = deleteEnd = caret (the char isn't in the doc yet).
 */
function buildAutoFormulaTr(
  state: EditorState,
  registry: FormulaRegistry,
  char: string,
  boundary: number,
  deleteEnd: number,
): Transaction | null {
  if (!hasFormulaNode(state.schema)) return null;
  const $b = state.doc.resolve(boundary);
  if ($b.parent.type.name === 'title') return null; // never auto-formula in the note title
  const blockStart = $b.start();
  const textBefore = state.doc.textBetween(blockStart, boundary);
  const match = registry.detectAuto(char, textBefore);
  if (!match) return null; // not a formula context → the char types normally (silent on prose)

  // default true (math's '='): the trigger char is consumed. false (hexcolor's boundary space): keep it.
  const consumesTrigger = match.type.autoTrigger?.consumesTrigger !== false;
  const trimmedEnd = textBefore.replace(/\s+$/, '');
  const runStartOffset = trimmedEnd.length - match.spec.length;
  if (runStartOffset < 0) return null; // safety: spec must be a suffix of the trimmed text-before
  const runFrom = blockStart + runStartOffset;
  const runTo = blockStart + trimmedEnd.length;

  const tr = state.tr;
  if (consumesTrigger && deleteEnd > runTo) tr.delete(runTo, deleteEnd); // drop trailing space + the trigger char
  tr.replaceWith(runFrom, runTo, formulaNode(state.schema, match.type.id, match.spec));
  // Non-consuming (boundary) trigger: the char isn't in the doc when the rule/keypad fires AND handling it
  // suppresses the default insert — so re-insert it after the wrap (both paths) so the boundary char stays.
  if (!consumesTrigger) tr.insertText(char);
  return tr;
}

/**
 * Register the formula INSERT transforms into the unified input pipeline ([ROAD-0007] step 2): one auto
 * rule per registry trigger char ('=' math consuming; ' ' hexcolor non-consuming) + the '[...]' bracket
 * rule. Handler bodies are the pre-pipeline InputRule bodies, verbatim — `start`/`end` arrive with the
 * exact prosemirror-inputrules semantics (the trigger char is prospective, so replacing/deleting through
 * `end` consumes it; buildAutoFormulaTr is parameterized for precisely this shape). MUST be registered
 * BEFORE the markdown transforms (design §5.4: formula → markdown → marks — a trailing run is a formula
 * first if its registry claims it, exactly the old plugin order).
 */
export function registerFormulaTransforms(transforms: TransformRegistry, registry: FormulaRegistry): void {
  for (const char of registry.triggerChars()) {
    transforms.addInsert({
      id: `formula-auto-${char === ' ' ? 'space' : char}`,
      match: new RegExp(`\\${char}$`),
      handler: (state, _m, start, end) => buildAutoFormulaTr(state, registry, char, start, end),
    });
  }
  // Fires on the closing ']' (prospective): [start, end] spans "[content" in the doc; the capture group
  // carries the content; replacing [start, end] with the node consumes the ']' (it's never inserted).
  transforms.addInsert({
    id: 'formula-bracket',
    match: /\[([^[\]]*)\]$/,
    handler: (state, m, start, end) => {
      if (!hasFormulaNode(state.schema)) return null;
      const $start = state.doc.resolve(start);
      if ($start.parent.type.name === 'title') return null;
      const content = m[1] ?? '';
      const match = registry.resolveBracket(content);
      if (!match) return null; // nothing matches → leave the literal "[...]" as plain text
      return state.tr.replaceWith(start, end, formulaNode(state.schema, match.type.id, match.spec));
    },
  });
  // EDIT surface ([ROAD-0007] step 3) — the unwraps + the Enter boundary-wrap join the shared chains.
  // Chain positions (design §3.4, load-bearing): backspace/forwardDelete unwraps run before atom-delete;
  // the boundary-wrap runs BEFORE linkify on Enter ("a trailing token is either a formula or a URL").
  transforms.addEdit('backspace', { id: 'formula-unwrap', cmd: unwrapFormulaBackspace });
  transforms.addEdit('forwardDelete', { id: 'formula-unwrap-delete', cmd: unwrapFormulaDelete });
  transforms.addEdit('enterBoundary', {
    id: 'formula-boundary-wrap',
    cmd: (state, dispatch) => maybeWrapBoundaryFormula(state, dispatch, registry),
  });
}

/**
 * BOUNDARY-on-ENTER (and reusable for any non-char boundary): wrap a trailing boundary-detected token (e.g.
 * a bare 6-digit hex) into a formula node, NO char inserted — the caller then performs the normal Enter.
 * Returns true if it wrapped. Registered on the shared enterBoundary chain above (both keyboards).
 */
function maybeWrapBoundaryFormula(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  registry: FormulaRegistry,
): boolean {
  if (!hasFormulaNode(state.schema) || !state.selection.empty) return false;
  const pos = state.selection.from;
  const $b = state.doc.resolve(pos);
  if ($b.parent.type.name === 'title') return false;
  const blockStart = $b.start();
  const textBefore = state.doc.textBetween(blockStart, pos);
  const match = registry.detectBoundary(textBefore);
  if (!match) return false;
  const trimmedEnd = textBefore.replace(/\s+$/, '');
  const runStartOffset = trimmedEnd.length - match.spec.length;
  if (runStartOffset < 0) return false;
  const runFrom = blockStart + runStartOffset;
  const runTo = blockStart + trimmedEnd.length;
  if (dispatch) dispatch(state.tr.replaceWith(runFrom, runTo, formulaNode(state.schema, match.type.id, match.spec)));
  return true;
}

/** Backspace at the RIGHT EDGE of a formula chip → unwrap it to plain editable text (the spec). Inside the
 *  spec, backspace edits normally (live recompute). Shared by the keymap + the deckAdapter backspace. */
export const unwrapFormulaBackspace: Command = (state, dispatch): boolean => {
  if (!state.selection.empty) return false;
  const pos = state.selection.from;
  const before = state.doc.resolve(pos).nodeBefore;
  if (!before || before.type.name !== 'formula') return false;
  if (dispatch) {
    const from = pos - before.nodeSize;
    const spec = before.textContent;
    dispatch(spec.length > 0
      ? state.tr.replaceWith(from, pos, state.schema.text(spec))
      : state.tr.delete(from, pos));
  }
  return true;
};

/** SPIKE (Mechanic B): symmetric FORWARD-DELETE. Delete at the LEFT EDGE of a formula chip (caret right
 *  BEFORE it) → unwrap it to its plain-text spec, caret left at the START of that text to keep editing —
 *  the mirror of {@link unwrapFormulaBackspace}. Additive: returns false when the caret isn't immediately
 *  before a formula, so the base Delete (and everything else) is untouched. */
export const unwrapFormulaDelete: Command = (state, dispatch): boolean => {
  if (!state.selection.empty) return false;
  const pos = state.selection.from;
  const after = state.doc.resolve(pos).nodeAfter;
  if (!after || after.type.name !== 'formula') return false;
  if (dispatch) {
    const to = pos + after.nodeSize;
    const spec = after.textContent;
    // replaceWith maps the caret to the START of the inserted text (pos), so editing continues in-place.
    dispatch(spec.length > 0
      ? state.tr.replaceWith(pos, to, state.schema.text(spec))
      : state.tr.delete(pos, to));
  }
  return true;
};

