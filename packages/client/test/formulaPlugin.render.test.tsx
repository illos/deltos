/**
 * Inline-formula FRAMEWORK + math-type integration tests (docs/specs/inline-formulas.md). Real
 * ProseMirror EditorView with the formula plugins + the type-dispatched NodeView. This is the regression
 * gate for the math refactor: every behavior the shipped math chip had (the '=' trigger fires/skips,
 * precedence, live recompute, div0 subtle error, backspace-unwrap, the deckAdapter/keypad path) must stay
 * green — now via a formula NODE instead of a mark. Plus the new framework surface: the '[...]' bracket
 * path, the registry, the deckAdapter dual-wire for both triggers, and the spine round-trip (incl. the
 * legacy math-mark → node upgrade).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { deltoSchema } from '../src/editor/schema.js';
import {
  createDefaultFormulaRegistry,
  registerFormulaTransforms,
  buildFormulaNodeView,
  unwrapFormulaBackspace,
} from '../src/plugins/formula/index.js';
import { buildKeymapPlugin } from '../src/editor/keymap.js';
import { TransformRegistry, buildInputPipelinePlugin } from '../src/editor/inputPipeline/index.js';
import { buildPmKeyActions } from '../src/editor/deckAdapter.js';
import { spineToPmDoc, pmDocToSpine, type TextSegment } from '../src/editor/serializer.js';
import type { BlockBody } from '@deltos/shared';

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; document.body.innerHTML = ''; });

const registry = createDefaultFormulaRegistry();

/** ALL formula input behavior rides the unified input pipeline ([ROAD-0007] steps 2+3) — insert triggers
 *  AND the edit surface (unwraps, Enter boundary-wrap). The mounts carry the pipeline plugin + the ONE
 *  keymap consuming the compiled chains, exactly as production assembles it. */
function formulaTransforms(): TransformRegistry {
  const r = new TransformRegistry();
  registerFormulaTransforms(r, registry);
  return r;
}
const mountPlugins = () => [
  buildInputPipelinePlugin(formulaTransforms()),
  buildKeymapPlugin(deltoSchema, formulaTransforms()),
];

/** Mount an editor (formula plugins + NodeView) whose body paragraph holds `text`, caret at the end. */
function mountWithText(text: string): EditorView {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const para = deltoSchema.nodes['paragraph']!.create({ id: null }, text ? deltoSchema.text(text) : []);
  const title = deltoSchema.nodes['title']!.create({ id: null });
  const doc = deltoSchema.nodes['doc']!.create(null, [title, para]);
  let state = EditorState.create({ doc, plugins: mountPlugins() });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  view = new EditorView(container, { state, nodeViews: { formula: buildFormulaNodeView(registry) } });
  return view;
}

/** Mount from a spine body (exercises the round-trip / NodeView render path). */
function mountFromBody(body: BlockBody): EditorView {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const doc = spineToPmDoc(deltoSchema, body, '');
  view = new EditorView(container, {
    state: EditorState.create({ doc, plugins: mountPlugins() }),
    nodeViews: { formula: buildFormulaNodeView(registry) },
  });
  return view;
}

/** The Deck path: the SAME generic runner call deckAdapter.insert makes in production. */
function deckInsert(v: EditorView, ch: string): void {
  buildPmKeyActions(() => v, formulaTransforms()).insert(ch);
}

function type(v: EditorView, ch: string): void {
  const { from } = v.state.selection;
  v.someProp('handleTextInput', (f) => f(v, from, from, ch));
}

/** The spec text inside the formula node (the editable expression), or null if no formula node. */
function formulaSpec(v: EditorView): string | null {
  let found: string | null = null;
  v.state.doc.descendants((node) => {
    if (node.type.name === 'formula') found = node.textContent;
  });
  return found;
}
const formulaType = (v: EditorView): string | null => {
  let t: string | null = null;
  v.state.doc.descendants((node) => { if (node.type.name === 'formula') t = node.attrs.ftype as string; });
  return t;
};
const resultValue = (v: EditorView) => (v.dom.parentElement ?? document).querySelector('.formula-output__value')?.textContent ?? null;
const hasErrorResult = (v: EditorView) => !!(v.dom.parentElement ?? document).querySelector('.formula-output--error');

describe('formula framework — math via the "=" auto-trigger (regression gate)', () => {
  it('fires on a trailing numeric expression: a math formula node + live result; "=" consumed', () => {
    const v = mountWithText('1 + 1');
    type(v, '=');
    expect(formulaSpec(v)).toBe('1 + 1');
    expect(formulaType(v)).toBe('math');
    expect(resultValue(v)).toBe('2');
  });

  it('precedence + the x alias', () => {
    const v = mountWithText('1 + 4 - 2 / 10'); type(v, '='); expect(resultValue(v)).toBe('4.8');
    const v2 = mountWithText('10 x 2'); type(v2, '='); expect(resultValue(v2)).toBe('20');
  });

  it('fires mid-sentence on the trailing run only', () => {
    const v = mountWithText('I paid 10 x 2');
    type(v, '=');
    expect(formulaSpec(v)).toBe('10 x 2');
    expect(resultValue(v)).toBe('20');
  });

  it('does NOT fire on prose', () => {
    const v = mountWithText('name = value');
    type(v, '=');
    expect(formulaSpec(v)).toBeNull();
    expect(resultValue(v)).toBeNull();
  });
});

describe('formula framework — the "[...]" explicit bracket path', () => {
  it('a bracketed math expression becomes a math formula on the closing "]"', () => {
    const v = mountWithText('[1 + 1');
    type(v, ']');
    expect(formulaSpec(v)).toBe('1 + 1');
    expect(formulaType(v)).toBe('math');
    expect(resultValue(v)).toBe('2');
  });

  it('a non-matching bracket stays LITERAL text (no formula)', () => {
    const v = mountWithText('[note to self');
    type(v, ']'); // the rule returns null → no formula; PM would insert the ']' normally (the harness
    expect(formulaSpec(v)).toBeNull();                 // doesn't simulate the default insert)
    expect(v.state.doc.textContent).toContain('note to self'); // content survives as plain text
  });
});

describe('formula framework — live recompute + error', () => {
  it('recomputes when the marked expression is edited', () => {
    const v = mountWithText('12 + 3');
    type(v, '=');
    expect(resultValue(v)).toBe('15');
    // delete the trailing '3' from inside the formula node's content → "12 + " → recompute to error
    const sel = TextSelection.atEnd(v.state.doc); // caret at doc end; step into the node's content
    v.dispatch(v.state.tr.setSelection(sel));
    // remove the last char of the formula's spec
    let specEnd = 0;
    v.state.doc.descendants((node, pos) => { if (node.type.name === 'formula') specEnd = pos + node.nodeSize - 1; });
    v.dispatch(v.state.tr.delete(specEnd - 1, specEnd));
    expect(resultValue(v)).toBeNull();
    expect(hasErrorResult(v)).toBe(true);
  });

  it('div by zero → subtle error (never crashes)', () => {
    const v = mountFromBody([{
      id: 'b1' as BlockBody[number]['id'], type: 'paragraph',
      content: { segments: [{ text: '1 / 0', formula: { type: 'math', state: null } } satisfies TextSegment] },
    }]);
    expect(resultValue(v)).toBeNull();
    expect(hasErrorResult(v)).toBe(true);
  });
});

describe('formula framework — backspace-unwrap', () => {
  it('backspace at the chip right edge removes the formula node (back to plain text)', () => {
    const v = mountWithText('1 + 1');
    type(v, '=');
    expect(formulaSpec(v)).toBe('1 + 1');
    expect(unwrapFormulaBackspace(v.state, v.dispatch)).toBe(true);
    expect(formulaSpec(v)).toBeNull();
    expect(v.state.doc.textContent).toBe('1 + 1'); // spec preserved as plain text
  });

  it('is a no-op when the caret is not after a formula', () => {
    const v = mountWithText('hello');
    expect(unwrapFormulaBackspace(v.state, v.dispatch)).toBe(false);
  });
});

// REGRESSION ([[deck-keypad-bypasses-inputrules-keymap]]): both triggers must fire on the deckAdapter
// (custom-keyboard) path, which bypasses input rules — via the unified pipeline's generic runner call
// ([ROAD-0007] step 2), the SAME registration the native path fires.
describe('formula framework — custom-keyboard insert path (via the input pipeline)', () => {
  it('"=" fires the math trigger on the keypad path (no input rule); "=" not inserted', () => {
    const v = mountWithText('10 + 5');
    deckInsert(v, '=');
    expect(formulaSpec(v)).toBe('10 + 5');
    expect(resultValue(v)).toBe('15');
    expect(v.state.doc.textContent).toBe('10 + 5');
  });

  it('"]" fires the bracket trigger on the keypad path', () => {
    const v = mountWithText('[2 + 2');
    deckInsert(v, ']');
    expect(formulaSpec(v)).toBe('2 + 2');
    expect(resultValue(v)).toBe('4');
  });

  it('a plain char does not fire (keypad inserts it normally)', () => {
    const v = mountWithText('10 + 5');
    deckInsert(v, 'a');
    expect(formulaSpec(v)).toBeNull();
    expect(v.state.doc.textContent).toBe('10 + 5a'); // the runner declined → plain insert
  });
});

// Formula type #2 (hexcolor) end-to-end — proves the framework dispatches to a SECOND type with a
// different (visual) output kind, additively, via the same bracket path.
const swatch = (v: EditorView) => (v.dom.parentElement ?? document).querySelector('.formula-swatch') as HTMLElement | null;

describe('formula framework — hexcolor type via the bracket path (proof of generality)', () => {
  it('[#FF5733] becomes a hexcolor formula rendering a colored swatch (not math)', () => {
    const v = mountWithText('[#FF5733');
    type(v, ']');
    expect(formulaType(v)).toBe('hexcolor');
    expect(formulaSpec(v)).toBe('#FF5733');
    const s = swatch(v);
    expect(s).not.toBeNull();
    expect(s!.style.backgroundColor).toBe('rgb(255, 87, 51)'); // #ff5733
  });

  it('[#abc] (3-digit) also resolves to a swatch', () => {
    const v = mountWithText('[#abc');
    type(v, ']');
    expect(formulaType(v)).toBe('hexcolor');
    expect(swatch(v)!.style.backgroundColor).toBe('rgb(170, 187, 204)'); // #aabbcc
  });

  it('the swatch updates live as the hex spec is edited', () => {
    const v = mountWithText('[#000000');
    type(v, ']');
    expect(swatch(v)!.style.backgroundColor).toBe('rgb(0, 0, 0)');
    // edit the last two spec chars 00 → ff (replace inside the formula node's content)
    let specEnd = 0;
    v.state.doc.descendants((node, pos) => { if (node.type.name === 'formula') specEnd = pos + node.nodeSize - 1; });
    v.dispatch(v.state.tr.insertText('ff', specEnd - 2, specEnd));
    expect(swatch(v)!.style.backgroundColor).toBe('rgb(0, 0, 255)'); // #0000ff
  });

  it('a math expression still routes to math, not hexcolor (registry order)', () => {
    const v = mountWithText('[1 + 1');
    type(v, ']');
    expect(formulaType(v)).toBe('math');
  });
});

describe('formula framework — hexcolor BARE auto-detect (non-consuming boundary trigger)', () => {
  it('bare 6-digit "#FF5733" + space → swatch, and the boundary space is PRESERVED', () => {
    const v = mountWithText('pick #FF5733');
    type(v, ' '); // the boundary trigger
    expect(formulaType(v)).toBe('hexcolor');
    expect(formulaSpec(v)).toBe('#FF5733');
    expect(swatch(v)!.style.backgroundColor).toBe('rgb(255, 87, 51)');
    expect(v.state.doc.textContent.endsWith(' ')).toBe(true); // space kept (re-inserted), not consumed
  });

  it('bare 3-digit "#abc" + space does NOT fire (stays plain text — #RGB is bracket-only)', () => {
    const v = mountWithText('say #abc');
    type(v, ' ');
    expect(formulaSpec(v)).toBeNull();
  });

  it('fires on the custom-keyboard path too (via the pipeline), space preserved', () => {
    const v = mountWithText('bg #00ff00');
    deckInsert(v, ' ');
    expect(formulaType(v)).toBe('hexcolor');
    expect(swatch(v)!.style.backgroundColor).toBe('rgb(0, 255, 0)');
    expect(v.state.doc.textContent.endsWith(' ')).toBe(true);
  });

  it('a normal space (no trailing hex) does not fire on the keypad path (plain insert)', () => {
    const v = mountWithText('hello world');
    deckInsert(v, ' ');
    expect(formulaSpec(v)).toBeNull();
    expect(v.state.doc.textContent).toBe('hello world ');
  });
});

// ENTER is a boundary too (Jim): bare hex + Enter → swatch AND the newline still happens — on both the
// hardware keymap Enter and the keypad (deckAdapter.enter) path.
const paragraphCount = (v: EditorView) => {
  let n = 0;
  v.state.doc.descendants((node) => { if (node.type.name === 'paragraph') n++; });
  return n;
};

describe('formula framework — ENTER as a boundary trigger', () => {
  it('hardware Enter: bare hex wraps to a swatch AND the newline still happens', () => {
    const v = mountWithText('pick #FF5733');
    expect(paragraphCount(v)).toBe(1);
    v.someProp('handleKeyDown', (f) => f(v, new KeyboardEvent('keydown', { key: 'Enter' })));
    expect(formulaType(v)).toBe('hexcolor');
    expect(swatch(v)!.style.backgroundColor).toBe('rgb(255, 87, 51)');
    expect(paragraphCount(v)).toBe(2); // block split → newline happened
  });

  it('keypad Enter (deckAdapter.enter): bare hex wraps to a swatch AND the newline still happens', () => {
    const v = mountWithText('bg #00ff00');
    const actions = buildPmKeyActions(() => v, formulaTransforms());
    actions.enter();
    expect(formulaType(v)).toBe('hexcolor');
    expect(swatch(v)!.style.backgroundColor).toBe('rgb(0, 255, 0)');
    expect(paragraphCount(v)).toBe(2);
  });

  it('plain Enter with no trailing boundary token just splits the block (no formula)', () => {
    const v = mountWithText('hello');
    v.someProp('handleKeyDown', (f) => f(v, new KeyboardEvent('keydown', { key: 'Enter' })));
    expect(formulaSpec(v)).toBeNull();
    expect(paragraphCount(v)).toBe(2);
  });
});

describe('formula framework — spine round-trip + legacy upgrade', () => {
  it('a formula node survives pmDocToSpine → spineToPmDoc (spec + type; result never stored)', () => {
    const body: BlockBody = [{
      id: 'b1' as BlockBody[number]['id'], type: 'paragraph',
      content: { segments: [{ text: '2 + 2', formula: { type: 'math', state: null } } satisfies TextSegment] },
    }];
    const round = pmDocToSpine(spineToPmDoc(deltoSchema, body, ''));
    const seg = (round[0]!.content as { segments: TextSegment[] }).segments[0]!;
    expect(seg.text).toBe('2 + 2');
    expect(seg.formula).toEqual({ type: 'math', state: null });
    expect('math' in seg).toBe(false); // not written as the legacy mark
  });

  it('LEGACY: an old math-MARK segment upgrades to a formula node on load (no migration)', () => {
    const body: BlockBody = [{
      id: 'b1' as BlockBody[number]['id'], type: 'paragraph',
      content: { segments: [{ text: '3 + 4', math: true } satisfies TextSegment] }, // pre-framework shape
    }];
    const v = mountFromBody(body);
    expect(formulaSpec(v)).toBe('3 + 4');   // became a formula node
    expect(formulaType(v)).toBe('math');
    expect(resultValue(v)).toBe('7');       // and renders live
    // re-saves as a formula segment, not the legacy mark
    const round = pmDocToSpine(v.state.doc);
    const seg = (round[0]!.content as { segments: TextSegment[] }).segments[0]!;
    expect(seg.formula).toEqual({ type: 'math', state: null });
  });
});
