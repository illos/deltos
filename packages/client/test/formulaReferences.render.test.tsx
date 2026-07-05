/**
 * Step-2 EDITOR WIRING tests (formula-engine.md §6–§8) — cross-formula references, the totalizer, the
 * nested-bracket ABSORB input rule, and the reactive host environment, against a REAL ProseMirror
 * EditorView + the type-dispatched NodeView + the real (dynamically imported) formula environment. This
 * is the mounted-DOM gate (ui-features-need-rendered-ui-gate): every assertion reads the rendered
 * ' = value' output DOM, not just engine state.
 *
 * Covered, per the Step-2 build order:
 *  - reference end-to-end, BOTH definition orders (locked decision #3, host-wired);
 *  - the totalizer ([J] ≡ [J:total], decision #1/#4) rendered through the group's type;
 *  - cross-type consumption (math reads an imperial ref as raw inches, decision #2) + the bare-reference
 *    DISPLAY-TYPE rule (decision #5): homogeneous group → the group's format; MIXED group → quiet ' = ?';
 *  - cycles → quiet ' = ?' with no hang (decision #4);
 *  - the absorb-on-outer-close input rule (§7) on the native path AND the Deck keypad path, incl. the
 *    consumer-typed-first order and the no-absorb-inside-an-existing-chip rule;
 *  - live recompute: editing a definition re-renders its consumer, and ONLY its consumer (changed-only).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { deltoSchema } from '../src/editor/schema.js';
import {
  createDefaultFormulaRegistry,
  registerFormulaTransforms,
  buildFormulaNodeView,
  createFormulaBroker,
} from '../src/plugins/formula/index.js';
import type { FormulaRegistry, FormulaType } from '../src/plugins/formula/index.js';
import { buildKeymapPlugin } from '../src/editor/keymap.js';
import { TransformRegistry, buildInputPipelinePlugin } from '../src/editor/inputPipeline/index.js';
import { buildPmKeyActions } from '../src/editor/deckAdapter.js';
import { spineToPmDoc, pmDocToSpine, type TextSegment } from '../src/editor/serializer.js';
import type { BlockBody } from '@deltos/shared';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = '';
});

function formulaTransforms(registry: FormulaRegistry): TransformRegistry {
  const r = new TransformRegistry();
  registerFormulaTransforms(r, registry);
  return r;
}

/** A paragraph block of segments (text and/or formula chips) for spine-driven mounts. */
const para = (id: string, segments: TextSegment[]): BlockBody[number] =>
  ({ id, type: 'paragraph', content: { segments } }) as BlockBody[number];
const chip = (text: string, type: string): TextSegment => ({ text, formula: { type, state: null } });

/** Mount a real EditorView from a spine body, with the full formula pipeline + broker-wired NodeView. */
function mountBody(body: BlockBody, registry: FormulaRegistry = createDefaultFormulaRegistry()): EditorView {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const doc = spineToPmDoc(deltoSchema, body, '');
  let state = EditorState.create({
    doc,
    plugins: [
      buildInputPipelinePlugin(formulaTransforms(registry)),
      buildKeymapPlugin(deltoSchema, formulaTransforms(registry)),
    ],
  });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  view = new EditorView(container, {
    state,
    nodeViews: { formula: buildFormulaNodeView(registry, createFormulaBroker()) },
  });
  return view;
}

/** Native-typing shape: the pipeline first; unhandled chars insert normally (what the browser would do). */
function typeChar(v: EditorView, ch: string): void {
  const { from, to } = v.state.selection;
  const handled = v.someProp('handleTextInput', (f) => f(v, from, to, ch));
  if (!handled) v.dispatch(v.state.tr.insertText(ch));
}
const typeText = (v: EditorView, text: string): void => {
  for (const ch of text) typeChar(v, ch);
};

/** All formula nodes in doc order: { spec, ftype }. */
function formulaNodes(v: EditorView): { spec: string; ftype: string }[] {
  const found: { spec: string; ftype: string }[] = [];
  v.state.doc.descendants((node) => {
    if (node.type.name === 'formula') found.push({ spec: node.textContent, ftype: node.attrs.ftype as string });
    return node.type.name !== 'formula';
  });
  return found;
}

/** The rendered output of the chip whose spec matches: the value text, 'ERR' for the quiet ' = ?', or null. */
function outputOf(v: EditorView, spec: string): string | null {
  const root = v.dom.parentElement ?? document;
  for (const el of root.querySelectorAll('.formula')) {
    if (el.querySelector('.formula__spec')?.textContent !== spec) continue;
    if (el.querySelector('.formula-output--error')) return 'ERR';
    return el.querySelector('.formula-output__value')?.textContent ?? null;
  }
  return null;
}

/** Wait for the lazy environment import + the coalesced microtask flush to land an expected output. */
const awaitOutput = (v: EditorView, spec: string, expected: string): Promise<void> =>
  vi.waitFor(() => expect(outputOf(v, spec)).toBe(expected));

describe('references end-to-end — [Y: 2+2] + [12 x [Y] / 2] → = 24, BOTH definition orders', () => {
  const definition = para('b1', [chip('Y: 2+2', 'math')]);
  const consumer = para('b2', [chip('12 x [Y] / 2', 'math')]);

  it('definition above the consumer', async () => {
    const v = mountBody([definition, consumer]);
    await awaitOutput(v, 'Y: 2+2', '4');
    await awaitOutput(v, '12 x [Y] / 2', '24');
  });

  it('definition BELOW the consumer resolves identically (order-independence, decision #3)', async () => {
    const v = mountBody([consumer, definition]);
    await awaitOutput(v, '12 x [Y] / 2', '24');
  });
});

describe('totalizer — bare [J] = SUM of the label group; [J:total] is the explicit synonym', () => {
  const body: BlockBody = [
    para('b1', [chip('J: 5"', 'imperial')]),
    para('b2', [chip('J: 7"', 'imperial')]),
    para('b3', [chip('J:total', 'ref'), { text: ' and ' }, chip('J', 'ref')]),
  ];

  it('[J: 5"] + [J: 7"] → [J:total] renders the imperial-formatted sum; bare [J] is identical', async () => {
    const v = mountBody(body);
    // 5″ + 7″ = 12 inches → the imperial formatter's foot form (formatInches(12) === '1′').
    await awaitOutput(v, 'J:total', '1′');
    await awaitOutput(v, 'J', '1′');
  });
});

describe('cross-type + the bare-reference display rule (decision #5)', () => {
  it('math consuming an imperial ref reads raw INCHES; a bare imperial ref echoes feet+inches', async () => {
    const v = mountBody([
      para('b1', [chip("T: 4'6\"", 'imperial')]), // 54 inches
      para('b2', [chip('2 x [T]', 'math')]),
      para('b3', [chip('T', 'ref')]),
    ]);
    await awaitOutput(v, '2 x [T]', '108'); // 54 read as a raw number by math
    await awaitOutput(v, 'T', '4′ 6″'); // homogeneous imperial group → imperial display
  });

  it('a MIXED-type group: [J:total] renders the quiet = ? (display only — consumers still read the sum)', async () => {
    const v = mountBody([
      para('b1', [chip('J: 5"', 'imperial')]), // 5 (inches)
      para('b2', [chip('J: 2+3', 'math')]), // 5 (number)
      para('b3', [chip('J:total', 'ref')]),
      para('b4', [chip('1 x [J]', 'math')]),
    ]);
    await awaitOutput(v, '1 x [J]', '10'); // the raw-scalar sum is consumable (decision #2)
    await awaitOutput(v, 'J:total', 'ERR'); // …but the bare chip has no honest unit → ' = ?'
  });
});

describe('cycles — quiet = ?, never a hang (decision #4)', () => {
  it('[A: [B]] / [B: [A]] both render the quiet error', async () => {
    const v = mountBody([
      para('b1', [chip('A: [B]', 'math')]),
      para('b2', [chip('B: [A]', 'math')]),
    ]);
    await awaitOutput(v, 'A: [B]', 'ERR');
    await awaitOutput(v, 'B: [A]', 'ERR');
  });
});

describe('nested brackets — the absorb-on-outer-close input rule (§7)', () => {
  it('NATIVE typing [12 x [Y] / 2 =] → the inner [Y] wraps live, the outer "]" absorbs to ONE node', async () => {
    const v = mountBody([para('b1', [chip('Y: 2+2', 'math'), { text: ' ' }])]);
    typeText(v, '[12 x [Y');
    typeChar(v, ']'); // inner close: [Y] wraps into a live reference chip (the label exists)
    expect(formulaNodes(v).map((f) => f.ftype)).toEqual(['math', 'ref']);
    typeText(v, ' / 2 =');
    typeChar(v, ']'); // outer close: balanced scan absorbs text + chip into ONE math node
    expect(formulaNodes(v)).toEqual([
      { spec: 'Y: 2+2', ftype: 'math' },
      { spec: '12 x [Y] / 2', ftype: 'math' }, // the reference is TEXTUAL in the spec ('=' normalized out)
    ]);
    await awaitOutput(v, '12 x [Y] / 2', '24');
  });

  it('the spec round-trips through the spine (serialize → deserialize) with the reference intact', () => {
    const v = mountBody([para('b1', [chip('Y: 2+2', 'math'), { text: ' ' }])]);
    typeText(v, '[12 x [Y] / 2 =');
    typeChar(v, ']');
    const round = pmDocToSpine(spineToPmDoc(deltoSchema, pmDocToSpine(v.state.doc), ''));
    const segs = (round[0]!.content as { segments: TextSegment[] }).segments;
    const consumer = segs.find((s) => s.text === '12 x [Y] / 2');
    expect(consumer?.formula).toEqual({ type: 'math', state: null });
  });

  it('the DECK keypad path behaves identically (the same pipeline runner)', async () => {
    const registry = createDefaultFormulaRegistry();
    const v = mountBody([para('b1', [chip('Y: 2+2', 'math'), { text: ' ' }])], registry);
    const actions = buildPmKeyActions(() => v, formulaTransforms(registry));
    for (const ch of '[12 x [Y] / 2 =]') actions.insert(ch);
    expect(formulaNodes(v)).toEqual([
      { spec: 'Y: 2+2', ftype: 'math' },
      { spec: '12 x [Y] / 2', ftype: 'math' },
    ]);
    await awaitOutput(v, '12 x [Y] / 2', '24');
  });

  it('CONSUMER TYPED FIRST: [Y] stays literal text, the outer "]" still absorbs to one node, and the ' +
    'later definition binds it (order-independence at the input layer)', async () => {
    const v = mountBody([para('b1', [])]);
    typeText(v, '[12 x [Y'); // no label Y in the doc yet → the doc-gate leaves [Y] literal
    typeChar(v, ']');
    expect(formulaNodes(v)).toEqual([]); // still plain text
    typeText(v, ' / 2 =');
    typeChar(v, ']'); // the balanced scan handles the literal inner brackets
    expect(formulaNodes(v)).toEqual([{ spec: '12 x [Y] / 2', ftype: 'math' }]);
    await awaitOutput(v, '12 x [Y] / 2', 'ERR'); // unresolved — Y doesn't exist yet
    typeText(v, ' [Y: 2+2');
    typeChar(v, ']');
    await awaitOutput(v, '12 x [Y] / 2', '24'); // the definition re-aims the reference live
  });

  it('typing [Y] into an EXISTING chip does NOT absorb — it only re-binds (the ref goes live)', async () => {
    const v = mountBody([
      para('b1', [chip('Z: 6+6', 'math')]),
      para('b2', [chip('2 x 3', 'math')]),
    ]);
    await awaitOutput(v, '2 x 3', '6');
    // Put the caret INSIDE the consumer chip's spec, after '2 x 3', and type ' x [Z]'.
    let inside: number | null = null;
    v.state.doc.descendants((node, pos) => {
      if (node.type.name === 'formula' && node.textContent === '2 x 3') inside = pos + 1 + node.content.size;
      return true;
    });
    expect(inside).not.toBeNull();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, inside!)));
    typeText(v, ' x [Z]'); // inside a chip the pipeline declines structurally — plain text lands in the spec
    expect(formulaNodes(v)).toEqual([
      { spec: 'Z: 6+6', ftype: 'math' },
      { spec: '2 x 3 x [Z]', ftype: 'math' }, // ONE node still — no absorb, the spec just grew
    ]);
    await awaitOutput(v, '2 x 3 x [Z]', '72'); // and the new reference binds live (6 × 12)
  });

  it('prose brackets never become dead chips: [note to self] and an unpublished [x] stay literal', () => {
    const v = mountBody([para('b1', [])]);
    typeText(v, '[note to self');
    typeChar(v, ']');
    typeText(v, ' [x');
    typeChar(v, ']');
    expect(formulaNodes(v)).toEqual([]);
    expect(v.state.doc.textContent).toContain('note to self');
  });

  it('a TYPED totalizer [J:total] wraps via the doc-label gate and renders the group-typed sum', async () => {
    const v = mountBody([
      para('b1', [chip('J: 5"', 'imperial'), { text: ' ' }, chip('J: 7"', 'imperial'), { text: ' ' }]),
    ]);
    typeText(v, '[J:total');
    typeChar(v, ']');
    expect(formulaNodes(v).at(-1)).toEqual({ spec: 'J:total', ftype: 'ref' });
    await awaitOutput(v, 'J:total', '1′');
  });

  it('POSITION-SAFETY: the "=" trigger after an earlier chip in the same block wraps ONLY the trailing ' +
    'text run at exact doc positions (a chip is a wall — its inner text never joins the run)', () => {
    const v = mountBody([para('b1', [chip('2+2', 'math'), { text: ' 10 x 2' }])]);
    typeChar(v, '=');
    expect(formulaNodes(v)).toEqual([
      { spec: '2+2', ftype: 'math' }, // untouched — no corruption from flattened-offset math
      { spec: '10 x 2', ftype: 'math' },
    ]);
  });

  it('the "=" auto-wrap inside an unclosed bracket does NOT absorb into a bogus reference (pre-Step-2 parity)', () => {
    const v = mountBody([para('b1', [])]);
    typeText(v, '[1 + 1'); // …then '=' fires the auto trigger: the run wraps into a chip, the '[' stays text
    typeChar(v, '=');
    expect(formulaNodes(v)).toEqual([{ spec: '1 + 1', ftype: 'math' }]);
    typeChar(v, ']'); // '[1 + 1]' re-serialized is NOT label-shaped → no reference, no absorb — ']' is literal
    expect(formulaNodes(v)).toEqual([{ spec: '1 + 1', ftype: 'math' }]);
    expect(v.state.doc.textContent).toContain(']');
  });
});

describe('live recompute — changed-only re-render (§8)', () => {
  it('editing the definition re-renders its consumer with the new value; an unrelated formula does not re-render', async () => {
    // Spy at the type level: renderOutput(spec, …) carries the chip's spec, so calls are per-chip attributable.
    const registry = createDefaultFormulaRegistry();
    const spied = new Map<string, ReturnType<typeof vi.fn>>();
    const wrap = (id: string): void => {
      const type = registry.get(id) as FormulaType;
      const spy = vi.fn(type.renderOutput.bind(type));
      (type as { renderOutput: FormulaType['renderOutput'] }).renderOutput = spy;
      spied.set(id, spy);
    };
    // A fresh registry instance per test file run — wrapping is contained here.
    wrap('math');
    wrap('ref');

    const v = mountBody(
      [
        para('b1', [chip('Y: 2+2', 'math')]),
        para('b2', [chip('3 x [Y]', 'math')]),
        para('b3', [chip('5 + 5', 'math')]), // the unrelated island
      ],
      registry,
    );
    await awaitOutput(v, '3 x [Y]', '12');
    for (const spy of spied.values()) spy.mockClear();

    // Edit the definition's spec: 'Y: 2+2' → 'Y: 2+3' (replace the final character inside the chip).
    let specEnd = 0;
    v.state.doc.descendants((node, pos) => {
      if (node.type.name === 'formula' && node.textContent === 'Y: 2+2') specEnd = pos + node.nodeSize - 1;
      return true;
    });
    v.dispatch(v.state.tr.insertText('3', specEnd - 1, specEnd));

    await awaitOutput(v, '3 x [Y]', '15'); // the consumer re-rendered with the new value
    const mathSpy = spied.get('math')!;
    const specsRendered = mathSpy.mock.calls.map((c) => c[0] as string);
    expect(specsRendered).not.toContain('5 + 5'); // the unrelated island re-rendered NOTHING
    expect(specsRendered).toContain('3 x [Y]');
  });
});
