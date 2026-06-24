import type { Plugin, Command, EditorState, Transaction } from 'prosemirror-state';
import type { Node as PmNode, Schema } from 'prosemirror-model';
import { InputRule, inputRules } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import type { FormulaRegistry } from './formulaTypes.js';
import './formula.css';

/**
 * Inline-formula EDITOR PLUGINS (docs/specs/inline-formulas.md §1) — the two entry paths + the unwrap, all
 * self-contained (the plugin owns its OWN inputRules plugin; core inputRules.ts is untouched). Wrapping
 * builds a content-bearing `formula` NODE (spec = its text content); the type-dispatched NodeView renders
 * the output. Math is the first type; the logic is type-generic via the injected registry.
 *
 * ⚠ DUAL-WIRING ([[deck-keypad-bypasses-inputrules-keymap]]): the custom keypad inserts via deckAdapter,
 * bypassing input rules AND the keymap. So BOTH triggers ('=' auto + '[...]' bracket) and the unwrap are
 * ALSO exposed as commands ({@link formulaTriggerOnInsert}, {@link unwrapFormulaBackspace}) the deckAdapter
 * calls — the framework fires on the Deck (Jim's primary path) and on hardware identically.
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
 * BRACKET path: a closing ']' resolves the preceding '[...' content against the registry. `closeAt` = the
 * position just AFTER the content (the caret on the keypad path, where ']' isn't inserted yet; the input
 * rule passes the analogous range). If a type matches, replace '[content' (+ the consumed ']') with a
 * formula node; if none match, return null → the literal text stays.
 */
function buildBracketFormulaTr(state: EditorState, registry: FormulaRegistry, closeAt: number): Transaction | null {
  if (!hasFormulaNode(state.schema)) return null;
  const $c = state.doc.resolve(closeAt);
  if ($c.parent.type.name === 'title') return null;
  const blockStart = $c.start();
  const textBefore = state.doc.textBetween(blockStart, closeAt);
  const openIdx = textBefore.lastIndexOf('[');
  if (openIdx < 0) return null;
  const content = textBefore.slice(openIdx + 1);
  if (content.includes('[') || content.includes(']')) return null; // no nesting
  const match = registry.resolveBracket(content);
  if (!match) return null; // nothing matches → leave the literal "[...]" as plain text
  const openPos = blockStart + openIdx;
  return state.tr.replaceWith(openPos, closeAt, formulaNode(state.schema, match.type.id, match.spec));
}

/**
 * The trigger for the CUSTOM-KEYBOARD insert path (deckAdapter). Called BEFORE the keypad inserts `char` —
 * the char is not in the doc yet, so boundary/closeAt = the caret. Returns true (+ dispatches the wrap) when
 * a formula fires, so the caller skips inserting the char; false → insert it normally.
 */
export function formulaTriggerOnInsert(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  registry: FormulaRegistry,
  char: string,
): boolean {
  if (!state.selection.empty) return false;
  const pos = state.selection.from;
  if (registry.triggerChars().includes(char)) {
    const tr = buildAutoFormulaTr(state, registry, char, pos, pos);
    if (tr) { if (dispatch) dispatch(tr); return true; }
  }
  if (char === ']') {
    const tr = buildBracketFormulaTr(state, registry, pos);
    if (tr) { if (dispatch) dispatch(tr); return true; }
  }
  return false;
}

/**
 * BOUNDARY-on-ENTER (and reusable for any non-char boundary): wrap a trailing boundary-detected token (e.g.
 * a bare 6-digit hex) into a formula node, NO char inserted — the caller then performs the normal Enter.
 * Returns true if it wrapped. Shared by the keymap Enter (hardware) + deckAdapter.enter (keypad).
 */
export function maybeWrapBoundaryFormula(
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

/** All inline-formula editor plugins, bound to a registry. The unwrap keymap goes BEFORE the base keymap;
 *  the input rules carry the auto triggers (one per registered trigger char) + the bracket rule. */
export function buildFormulaPlugins(registry: FormulaRegistry): Plugin[] {
  const autoRules = registry.triggerChars().map(
    (char) => new InputRule(new RegExp(`\\${char}$`), (state, _m, start, end) =>
      buildAutoFormulaTr(state, registry, char, start, end)),
  );
  // The input rule fires AFTER ']' is inserted: the regex captures "[content]"; resolve via closeAt = the
  // ']' position so the same builder handles it (deletes through the caret/']').
  const bracketRule = new InputRule(/\[([^[\]]*)\]$/, (state, m, start, end) => {
    // input-rule mechanics: the typed ']' is NOT yet in the doc — the rule matches against the prospective
    // text, and [start, end] spans "[content" in the doc. So take the content from the CAPTURE GROUP (m[1]),
    // and replacing [start, end] with the node consumes the ']' (it's never inserted). Same as the keypad path.
    if (!hasFormulaNode(state.schema)) return null;
    const $start = state.doc.resolve(start);
    if ($start.parent.type.name === 'title') return null;
    const content = m[1] ?? '';
    const match = registry.resolveBracket(content);
    if (!match) return null;
    return state.tr.replaceWith(start, end, formulaNode(state.schema, match.type.id, match.spec));
  });
  return [
    keymap({
      Backspace: unwrapFormulaBackspace,
      // ENTER is a boundary too (Jim): wrap a trailing boundary token (bare hex), THEN do the normal Enter
      // on the updated state. Returns false when there's no boundary formula, so the editor's normal Enter
      // chain (lists/todos) is untouched in the common case.
      Enter: (state, dispatch, view) => {
        if (!dispatch || !view) return false;
        if (!maybeWrapBoundaryFormula(state, dispatch, registry)) return false;
        baseKeymap['Enter']!(view.state, view.dispatch, view); // normal Enter on the post-wrap state
        return true;
      },
    }),
    inputRules({ rules: [...autoRules, bracketRule] }),
  ];
}
