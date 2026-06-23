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

/**
 * THE shared "=" trigger logic — one source of truth for BOTH the input rule (native/hardware text input)
 * AND the custom-keyboard insert path (deckAdapter), which bypasses ProseMirror's input-rule/keymap layer.
 * If the text before `boundary` ends in a trailing arithmetic expression, returns a transaction that wraps
 * that run in the `math` mark and deletes `[runEnd, deleteEnd)` (the typed '=' + any space before it); else
 * null. `boundary` = where text-before is read; `deleteEnd` = how far to clear after the expression.
 *
 * ⚠ DUAL-WIRING (lesson): the custom keypad inserts via deckAdapter, NOT through input rules / the keymap —
 * so any input-rule/keymap-triggered editor feature MUST also be wired into deckAdapter (cf. backspace-
 * unwrap). The math trigger lives in both: the input rule (boundary=the '=' pos, deleteEnd=after it) and
 * {@link mathTriggerOnInsert} (the keypad path; boundary=deleteEnd=caret, no '=' in the doc yet).
 */
export function buildMathWrapTr(state: EditorState, boundary: number, deleteEnd: number): Transaction | null {
  const mathType = state.schema.marks['math'];
  if (!mathType) return null;
  const $b = state.doc.resolve(boundary);
  if ($b.parent.type.name === 'title') return null; // never auto-math in the note title
  const blockStart = $b.start();
  const textBefore = state.doc.textBetween(blockStart, boundary);
  const run = detectTrailingExpression(textBefore);
  if (!run) return null; // not a math context → caller inserts the '=' normally (silent on prose)

  // Locate the run in the doc: it is the trailing substring of the right-trimmed text-before-boundary.
  const trimmedEnd = textBefore.replace(/\s+$/, '');
  const runStartOffset = trimmedEnd.length - run.length;
  if (runStartOffset < 0) return null; // safety: run must be a suffix
  const runFrom = blockStart + runStartOffset;
  const runTo = blockStart + trimmedEnd.length;

  const tr = state.tr;
  if (deleteEnd > runTo) tr.delete(runTo, deleteEnd); // drop trailing space + the typed '=' (decoration shows "= result")
  tr.addMark(runFrom, runTo, mathType.create());
  tr.removeStoredMark(mathType);                      // typing past the chip is plain text, not more math
  return tr;
}

/**
 * The "=" trigger for the CUSTOM-KEYBOARD insert path (deckAdapter). The keypad calls this BEFORE inserting
 * a typed '=' — there is no '=' in the doc yet, so boundary = deleteEnd = the caret. Returns true (and
 * dispatches the wrap) when it fires, so the caller skips inserting the '='; false → insert '=' normally.
 */
export function mathTriggerOnInsert(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  if (!state.selection.empty) return false;
  const pos = state.selection.from;
  const tr = buildMathWrapTr(state, pos, pos);
  if (!tr) return false;
  if (dispatch) dispatch(tr);
  return true;
}

/** The "=" trigger as the plugin's OWN inputRules plugin (never the shared core inputRules.ts). */
function mathInputRulesPlugin(_schema: Schema): Plugin {
  // The input rule fires AFTER '=' is inserted: boundary = the '=' position (start), deleteEnd = after it.
  const rule = new InputRule(/=$/, (state, _match, start, end) => buildMathWrapTr(state, start, end));
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
