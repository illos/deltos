/**
 * Imperial formula type — end-to-end via the real ProseMirror editor (docs/specs/inline-formulas.md).
 * Proves the framework dispatches to a THIRD type (feet/inch adder, text output) additively, via the same
 * `[...]` bracket path, that it stays DISJOINT from math on that shared path, and that an imperial node
 * survives a spine round-trip. Mirrors formulaPlugin.render.test.tsx's harness.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { deltoSchema } from '../src/editor/schema.js';
import {
  createDefaultFormulaRegistry,
  registerFormulaTransforms,
  buildFormulaNodeView,
} from '../src/plugins/formula/index.js';
import { mathType } from '../src/plugins/math/mathType.js';
import { imperialType } from '../src/plugins/imperial/imperialType.js';
import { buildKeymapPlugin } from '../src/editor/keymap.js';
import { TransformRegistry, buildInputPipelinePlugin } from '../src/editor/inputPipeline/index.js';
import { spineToPmDoc, pmDocToSpine, type TextSegment } from '../src/editor/serializer.js';
import type { BlockBody } from '@deltos/shared';

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; document.body.innerHTML = ''; });

const registry = createDefaultFormulaRegistry();

function formulaTransforms(): TransformRegistry {
  const r = new TransformRegistry();
  registerFormulaTransforms(r, registry);
  return r;
}
const mountPlugins = () => [
  buildInputPipelinePlugin(formulaTransforms()),
  buildKeymapPlugin(deltoSchema, formulaTransforms()),
];

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

function type(v: EditorView, ch: string): void {
  const { from } = v.state.selection;
  v.someProp('handleTextInput', (f) => f(v, from, from, ch));
}
function formulaSpec(v: EditorView): string | null {
  let found: string | null = null;
  v.state.doc.descendants((node) => { if (node.type.name === 'formula') found = node.textContent; });
  return found;
}
const formulaType = (v: EditorView): string | null => {
  let t: string | null = null;
  v.state.doc.descendants((node) => { if (node.type.name === 'formula') t = node.attrs.ftype as string; });
  return t;
};
const resultValue = (v: EditorView) =>
  (v.dom.parentElement ?? document).querySelector('.formula-output__value')?.textContent ?? null;

describe('imperial type — the "[...]" bracket path (proof of a 3rd type)', () => {
  it('[Trim: 5\' 3"] becomes an imperial formula node rendering the summed total', () => {
    const v = mountWithText(`[Trim: 5' 3"`);
    type(v, ']');
    expect(formulaType(v)).toBe('imperial');
    expect(formulaSpec(v)).toBe(`Trim: 5' 3"`);
    expect(resultValue(v)).toBe('5′ 3″'); // 5ft + 3in = 63"
  });

  it('the worked example [Trim: 12, 123” 4 4’5” 12-15/16” 12’6”] → 44′ 2-15/16″', () => {
    const v = mountWithText('[Trim: 12, 123” 4 4’5” 12-15/16” 12’6”');
    type(v, ']');
    expect(formulaType(v)).toBe('imperial');
    expect(resultValue(v)).toBe('44′ 2-15/16″');
  });

  it('[12\'] (bare feet mark, no label) resolves to imperial', () => {
    const v = mountWithText(`[12'`);
    type(v, ']');
    expect(formulaType(v)).toBe('imperial');
    expect(resultValue(v)).toBe('12′'); // 12 ft
  });
});

describe('imperial ↔ math disjointness on the shared bracket path', () => {
  it('a bracketed arithmetic expression still routes to MATH, not imperial', () => {
    const v = mountWithText('[1 + 1');
    type(v, ']');
    expect(formulaType(v)).toBe('math');
    expect(resultValue(v)).toBe('2');
  });

  it('[12\'] → imperial and [12] → nobody claims (both math and imperial decline a bare number)', () => {
    expect(registry.resolveBracket("12'")).toEqual({ type: imperialType, spec: "12'" });
    expect(registry.resolveBracket('12')).toBeNull();
    expect(registry.resolveBracket('1 + 1')).toEqual({ type: mathType, spec: '1 + 1' });
  });

  it('[12-15/16] (arithmetic, no unit mark) routes to math; [12-15/16"] (inch mark) to imperial', () => {
    expect(registry.resolveBracket('12-15/16')?.type).toBe(mathType);        // 12 - 15/16 = 11.0625
    expect(registry.resolveBracket('12-15/16"')?.type).toBe(imperialType);    // 12 15/16 inches
  });
});

describe('imperial — spine round-trip', () => {
  it('an imperial formula node survives pmDocToSpine → spineToPmDoc (spec + type; result not stored)', () => {
    const body: BlockBody = [{
      id: 'b1' as BlockBody[number]['id'], type: 'paragraph',
      content: { segments: [{ text: `Trim: 5' 3"`, formula: { type: 'imperial', state: null } } satisfies TextSegment] },
    }];
    // renders live from the body
    const v = mountFromBody(body);
    expect(formulaType(v)).toBe('imperial');
    expect(resultValue(v)).toBe('5′ 3″');
    // and re-serializes losslessly
    const round = pmDocToSpine(v.state.doc);
    const seg = (round[0]!.content as { segments: TextSegment[] }).segments[0]!;
    expect(seg.text).toBe(`Trim: 5' 3"`);
    expect(seg.formula).toEqual({ type: 'imperial', state: null });
  });
});
