import type { Command, EditorState, Transaction } from 'prosemirror-state';
import type { Node as PmNode, Schema } from 'prosemirror-model';
import type { TransformRegistry } from '../../editor/inputPipeline/index.js';
import type { FormulaMatch, FormulaRegistry } from './formulaTypes.js';
import { extractLabel, refTokenName } from './refBinding.js';
import { REFERENCE_FTYPE } from './referenceType.js';
import { LABELED_FTYPES } from './formulaHost.js';
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
 * Does any formula in the doc PUBLISH `label` (a `Label:`-tagged numeric spec — the substrate-common
 * label layer, refBinding.ts)? This is the DOC-GATE for bare-reference chips: `[Y]` only wraps when some
 * formula actually names Y, so prose brackets (`[note to self]`, a markdown `[x]`) never become dead
 * ' = ?' chips. Cheap: one walk over formula nodes, only run for label-shaped bracket content.
 */
function docHasLabel(doc: PmNode, label: string): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name !== 'formula') return true;
    if (LABELED_FTYPES.has(node.attrs.ftype as string) && extractLabel(node.textContent).label === label) {
      found = true;
    }
    return false; // formula content is the spec — never recurse into it
  });
  return found;
}

interface OuterBracketScan {
  /** Offset of the unmatched outer '[' within the block's inline content. */
  readonly openerOffset: number;
  /** The range (outer '[' exclusive → caret) serialized back to text — chips re-emit as `[spec]`. */
  readonly content: string;
}

/**
 * The bounded backward BALANCED bracket scan of the absorb rule (formula-engine.md §7): walk the block's
 * inline children from the caret toward the block start, tracking bracket depth through TEXT characters
 * while treating embedded formula chips as OPAQUE tokens (their own brackets were consumed when they
 * wrapped). Depth starts at 1 (the just-typed, prospective ']'); the character that brings it to 0 is the
 * unmatched OUTER opener. A non-text non-formula leaf (a hard_break etc.) is not serializable back to a
 * spec, so it BOUNDS the scan — an absorb range never crosses one. Returns null when no opener exists.
 * Bounded by construction: the scan never leaves `parent` and visits each inline child at most once.
 */
function scanOuterBracket(parent: PmNode, caretOffset: number): OuterBracketScan | null {
  interface Piece {
    readonly from: number;
    readonly text: string; // the serialized form (raw text, or a chip's '[spec]')
    readonly isText: boolean;
  }
  const pieces: Piece[] = [];
  parent.forEach((child, offset) => {
    if (offset >= caretOffset) return;
    if (child.isText) {
      const text = child.text ?? '';
      // The child under the caret contributes only its part BEFORE the caret.
      pieces.push({ from: offset, text: offset + text.length > caretOffset ? text.slice(0, caretOffset - offset) : text, isText: true });
    } else if (child.type.name === 'formula') {
      if (offset + child.nodeSize > caretOffset) return; // caret inside a chip never reaches here (belt)
      pieces.push({ from: offset, text: `[${child.textContent}]`, isText: false });
    } else {
      pieces.length = 0; // unserializable leaf → it bounds the scan (drop everything to its left)
    }
  });

  let depth = 1; // the prospective ']'
  for (let p = pieces.length - 1; p >= 0; p--) {
    const piece = pieces[p]!;
    if (!piece.isText) continue; // chips are opaque tokens
    for (let i = piece.text.length - 1; i >= 0; i--) {
      const ch = piece.text[i]!;
      if (ch === ']') depth++;
      else if (ch === '[') {
        depth--;
        if (depth === 0) {
          // Found the outer opener — serialize everything AFTER it up to the caret.
          let content = piece.text.slice(i + 1);
          for (let q = p + 1; q < pieces.length; q++) content += pieces[q]!.text;
          return { openerOffset: piece.from + i, content };
        }
      }
    }
  }
  return null;
}

/**
 * Resolve bracket content to a formula match — the registry's value types first, then the Step-2
 * BARE-REFERENCE path: label-shaped content (`Y`, `J:total`) becomes a reference chip IFF the doc
 * currently publishes that label (see {@link docHasLabel}). The reference type never self-claims via the
 * registry (its recognize declines), so this is the ONE place reference chips are minted — used by both
 * the single-level bracket rule and the absorb rule below.
 */
function resolveBracketContent(state: EditorState, registry: FormulaRegistry, content: string): FormulaMatch | null {
  const match = registry.resolveBracket(content);
  if (match) return match;
  const name = refTokenName(content);
  if (name === null || !docHasLabel(state.doc, name)) return null;
  const refType = registry.get(REFERENCE_FTYPE);
  return refType ? { type: refType, spec: content.trim() } : null;
}

/**
 * The trailing PLAIN-TEXT run before `pos` within its textblock, with a doc-accurate start position.
 *
 * POSITION-SAFETY (Step 2, load-bearing): the naive `textBetween(blockStart, pos)` FLATTENS an embedded
 * formula chip's inner text into the string (the chip is an inline NON-leaf node), so character offsets
 * over that string no longer map 1:1 to document positions (a chip is `spec.length + 2` positions wide but
 * contributes `spec.length` characters) — the replace range then lands INSIDE/around the chip and corrupts
 * the block. With references making chips common mid-run, every trigger scan must instead stop at a chip
 * WALL: any non-text inline child (a chip, a hard_break) bounds the run, its inner text never leaks into
 * trigger matching, and `from + offset` arithmetic over the returned text is exact.
 */
function trailingTextRun(state: EditorState, pos: number): { text: string; from: number } {
  const $pos = state.doc.resolve(pos);
  const caretOffset = $pos.parentOffset;
  let runStartOffset = 0;
  let text = '';
  $pos.parent.forEach((child, offset) => {
    if (offset >= caretOffset) return;
    if (child.isText) {
      const t = child.text ?? '';
      text += offset + t.length > caretOffset ? t.slice(0, caretOffset - offset) : t;
    } else {
      text = ''; // a chip/leaf is a wall — restart the run after it
      runStartOffset = offset + child.nodeSize;
    }
  });
  return { text, from: $pos.start() + runStartOffset };
}

/** Is `[from, to)` pure text (no inline non-text node — no chip, no hard_break)? Guards the bracket rule:
 *  a matched tail that crosses a chip has corrupt char↔position math AND is the absorb rule's territory. */
function isPureTextSpan(state: EditorState, from: number, to: number): boolean {
  let pure = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isInline && !node.isText) pure = false;
    return pure;
  });
  return pure;
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
  if (!$b.parent.isTextblock || $b.parent.type.name === 'title') return null; // never in the title / inside a chip
  const run = trailingTextRun(state, boundary); // chip-bounded: a chip's inner text never joins the run
  const match = registry.detectAuto(char, run.text);
  if (!match) return null; // not a formula context → the char types normally (silent on prose)

  // default true (math's '='): the trigger char is consumed. false (hexcolor's boundary space): keep it.
  const consumesTrigger = match.type.autoTrigger?.consumesTrigger !== false;
  const trimmedEnd = run.text.replace(/\s+$/, '');
  const runStartOffset = trimmedEnd.length - match.spec.length;
  if (runStartOffset < 0) return null; // safety: spec must be a suffix of the trimmed text-before
  const runFrom = run.from + runStartOffset;
  const runTo = run.from + trimmedEnd.length;

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
  // Step 2: also mints BARE-REFERENCE chips (`[Y]` / `[J:total]`) via the doc-label gate — the immediate
  // inner wrap of the absorb approach (§7: live feedback of Y's value while the outer formula is typed).
  transforms.addInsert({
    id: 'formula-bracket',
    match: /\[([^[\]]*)\]$/,
    handler: (state, m, start, end) => {
      if (!hasFormulaNode(state.schema)) return null;
      const $start = state.doc.resolve(start);
      if (!$start.parent.isTextblock || $start.parent.type.name === 'title') return null;
      // Position-safety: the runner's textBefore flattens chip inner text, so a match whose tail crosses
      // a chip carries corrupt char↔position math. Pure-text tails only — chip-crossing runs belong to
      // the absorb rule below, which does its own doc-structural scan.
      if (!isPureTextSpan(state, start, end)) return null;
      const content = m[1] ?? '';
      const match = resolveBracketContent(state, registry, content);
      if (!match) return null; // nothing matches → leave the literal "[...]" as plain text
      return state.tr.replaceWith(start, end, formulaNode(state.schema, match.type.id, match.spec));
    },
  });
  // NESTED brackets — the ABSORB-on-outer-close rule (formula-engine.md §7). Registered directly AFTER
  // the single-level rule: when THAT declines (the run before the caret contains an inner chip or literal
  // inner brackets), this one walks the block's inline content BACKWARD from the caret with a balanced
  // bracket scan — text contributes characters, embedded formula chips are OPAQUE tokens — to find the
  // unmatched outer '['. The scanned range is serialized BACK to text (chips re-emit their `[spec]` form),
  // recognized, and the WHOLE range — text and inner chips — is replaced with ONE formula node whose spec
  // carries the references textually (spine-persistable plain text; decisions #6/zero-migration hold).
  // Bounded by construction: never leaves the current textblock. Editing inside an EXISTING chip's spec
  // can never absorb — a formula node is not a textblock, so the pipeline declines there structurally.
  transforms.addInsert({
    id: 'formula-absorb',
    match: /\]$/,
    handler: (state, _m, start, end) => {
      if (!hasFormulaNode(state.schema)) return null;
      const $caret = state.doc.resolve(start);
      if (!$caret.parent.isTextblock || $caret.parent.type.name === 'title') return null;
      const scan = scanOuterBracket($caret.parent, $caret.parentOffset);
      if (!scan) return null;
      const match = resolveBracketContent(state, registry, scan.content);
      if (!match) return null; // not a recognizable formula → the ']' types literally
      const openerPos = $caret.start() + scan.openerOffset;
      return state.tr.replaceWith(openerPos, end, formulaNode(state.schema, match.type.id, match.spec));
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
  if (!$b.parent.isTextblock || $b.parent.type.name === 'title') return false;
  const run = trailingTextRun(state, pos); // chip-bounded (see trailingTextRun) — offsets are doc-exact
  const match = registry.detectBoundary(run.text);
  if (!match) return false;
  const trimmedEnd = run.text.replace(/\s+$/, '');
  const runStartOffset = trimmedEnd.length - match.spec.length;
  if (runStartOffset < 0) return false;
  const runFrom = run.from + runStartOffset;
  const runTo = run.from + trimmedEnd.length;
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

