import { Plugin, PluginKey } from 'prosemirror-state';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PmNode, MarkType, Schema } from 'prosemirror-model';
import { InputRule, inputRules } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { evaluate, detectTrailingExpression } from './mathEngine.js';
import './math.css';

/**
 * Inline-math EDITOR INTEGRATION (docs/specs/inline-math.md §3). Self-contained: this plugin owns its own
 * trigger (an inputRules plugin), so it never touches the shared core inputRules.ts (zero contention). It
 * imports only the editor-agnostic {@link evaluate}/{@link detectTrailingExpression} engine + ProseMirror.
 *
 * Model (navSys-2-approved): a dedicated `math` MARK (distinct from `code` so plain code is never
 * evaluated) carries the EXPRESSION as the persisted source of truth (round-trips via the spine, no
 * migration); the live "= result" is a derived DECORATION recomputed on every edit (the spellcheck-
 * decoration pattern, but synchronous — eval is instant). Trigger: typing `=` after a trailing arithmetic
 * run wraps it as math. Backspace at the chip's right edge unwraps it back to plain text (try-and-feel).
 */

const mathPluginKey = new PluginKey<DecorationSet>('inline-math');

/** Find each maximal contiguous run of `math`-marked text: its doc range + the expression string. */
function mathSpans(doc: PmNode, mathType: MarkType): { from: number; to: number; expr: string }[] {
  const out: { from: number; to: number }[] = [];
  let cur: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (node.isText && node.marks.some((m) => m.type === mathType)) {
      const from = pos;
      const to = pos + node.nodeSize;
      if (cur && cur.to === from) cur.to = to; // contiguous → extend the run
      else { if (cur) out.push(cur); cur = { from, to }; }
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
    return true;
  });
  if (cur) out.push(cur);
  return out.map((s) => ({ ...s, expr: doc.textBetween(s.from, s.to) }));
}

/** Build the "= result" widget DOM for an expression (result emphasized; subtle error on div0/malformed). */
function resultWidget(expr: string): HTMLElement {
  const span = document.createElement('span');
  span.contentEditable = 'false';
  const r = evaluate(expr);
  if (r.ok) {
    span.className = 'math-result';
    span.append(' = ');
    const value = document.createElement('span');
    value.className = 'math-result__value';
    value.textContent = String(r.value);
    span.appendChild(value);
  } else {
    // Div-by-zero / malformed → a SUBTLE error state, never a crash or a thrown exception.
    span.className = 'math-result math-result--error';
    span.textContent = ' = ?';
  }
  return span;
}

/** The decoration set: a non-editable "= result" widget after each math-marked expression. */
function buildDecorations(doc: PmNode, mathType: MarkType): DecorationSet {
  const decos = mathSpans(doc, mathType).map((s) => {
    const r = evaluate(s.expr);
    return Decoration.widget(s.to, () => resultWidget(s.expr), {
      side: 1, // render AFTER the expression
      // key keeps PM from recreating an unchanged widget; changes when the expr or its value changes.
      key: `math:${s.to}:${s.expr}:${r.ok ? r.value : 'err'}`,
    });
  });
  return DecorationSet.create(doc, decos);
}

/** The "=" trigger as the plugin's OWN inputRules plugin (never the shared core inputRules.ts). */
function mathInputRulesPlugin(schema: Schema): Plugin {
  const mathType = schema.marks['math'];
  const rule = new InputRule(/=$/, (state, _match, start, end) => {
    if (!mathType) return null;
    const $start = state.doc.resolve(start);
    if ($start.parent.type.name === 'title') return null; // never auto-math in the note title
    const blockStart = $start.start();
    const textBefore = state.doc.textBetween(blockStart, start);
    const run = detectTrailingExpression(textBefore);
    if (!run) return null; // not a math context → the '=' types normally (silent on prose)

    // Locate the run in the doc: it is the trailing substring of the right-trimmed text-before-'='.
    const trimmedEnd = textBefore.replace(/\s+$/, '');
    const runStartOffset = trimmedEnd.length - run.length;
    if (runStartOffset < 0) return null; // safety: run must be a suffix
    const runFrom = blockStart + runStartOffset;
    const runTo = blockStart + trimmedEnd.length;

    const tr = state.tr;
    tr.delete(runTo, end);                       // drop the typed '=' + any space before it (decoration shows "= result")
    tr.addMark(runFrom, runTo, mathType.create());
    tr.removeStoredMark(mathType);               // typing past the chip is plain text, not more math
    return tr;
  });
  return inputRules({ rules: [rule] });
}

/**
 * Backspace at the RIGHT EDGE of a math chip → unwrap the whole expression back to plain editable text
 * (Jim's try-and-feel exit). Mid-expression backspace is a normal char delete (so editing recomputes
 * live). Returns false everywhere else so the default Backspace runs. Exported so the custom-keyboard
 * backspace path (deckAdapter) can share it — the keypad bypasses the keymap.
 */
export const unwrapMathBackspace: Command = (state: EditorState, dispatch): boolean => {
  const mathType = state.schema.marks['math'];
  if (!mathType || !state.selection.empty) return false;
  const pos = state.selection.from;
  if (pos < 1 || !state.doc.rangeHasMark(pos - 1, pos, mathType)) return false;
  const span = mathSpans(state.doc, mathType).find((s) => s.to === pos); // caret exactly at the chip's right edge
  if (!span) return false;
  if (dispatch) dispatch(state.tr.removeMark(span.from, span.to, mathType));
  return true; // unwrapped (no char deleted); the next backspace edits the now-plain text
};

/** The live-result decoration plugin (recomputes on every doc change). */
function mathDecorationPlugin(schema: Schema): Plugin<DecorationSet> {
  const mathType = schema.marks['math']!;
  return new Plugin<DecorationSet>({
    key: mathPluginKey,
    state: {
      init: (_config, state) => buildDecorations(state.doc, mathType),
      apply(tr: Transaction, old: DecorationSet) {
        // Recompute on any doc change (cheap, synchronous) so editing the expression updates the result
        // live; otherwise ride the mapping (e.g. selection-only changes).
        return tr.docChanged ? buildDecorations(tr.doc, mathType) : old.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return mathPluginKey.getState(state);
      },
    },
  });
}

/**
 * All inline-math editor plugins, to spread into the editor's plugin list. Order: the unwrap keymap goes
 * BEFORE the base keymap (so it intercepts Backspace at a chip edge); the input rule + decoration are
 * order-independent. The host inserts these ahead of its base keymap.
 */
export function buildMathPlugins(schema: Schema): Plugin[] {
  return [
    keymap({ Backspace: unwrapMathBackspace }),
    mathInputRulesPlugin(schema),
    mathDecorationPlugin(schema),
  ];
}
