/**
 * Formula unwrap — Mechanic B: formulas "unwrap to plain text" instead of deleting. Backspace at the right
 * edge (already shipped: unwrapFormulaBackspace) AND the symmetric forward-Delete at the left edge replace
 * the rendered formula with its plain-text SOURCE (the spec), caret left in that text. Re-triggering the
 * existing auto-detect re-renders it. Both commands ride the pipeline's shared backspace/forwardDelete
 * chains ([ROAD-0007] step 3); the Deck-path coverage is in deckBlockObjectDelete.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { deltoSchema as S } from '../src/editor/schema.js';
import { createDefaultFormulaRegistry } from '../src/plugins/formula/index.js';
import {
  unwrapFormulaBackspace,
  unwrapFormulaDelete,
  registerFormulaTransforms,
} from '../src/plugins/formula/formulaPlugin.js';
import { TransformRegistry, runPreInsert } from '../src/editor/inputPipeline/index.js';

const registry = createDefaultFormulaRegistry();

function formulaDoc(spec = '2+2') {
  const f = S.nodes['formula']!.create({ ftype: 'math', state: null }, S.text(spec));
  return S.node('doc', null, [
    S.node('title', { id: 't' }, [S.text('T')]),
    S.node('paragraph', { id: 'p' }, [f]),
  ]);
}
function formulaPos(doc: ReturnType<typeof formulaDoc>) {
  let p = -1, size = 0;
  doc.descendants((n, pos) => { if (n.type.name === 'formula') { p = pos; size = n.nodeSize; } });
  return { p, size };
}
function hasFormula(state: EditorState) {
  let f = false; state.doc.descendants((n) => { if (n.type.name === 'formula') f = true; });
  return f;
}

describe('Mechanic B — Backspace at the right edge unwraps to source (shipped, regression guard)', () => {
  it('Backspace right after a math chip → "2+2" plain text, no formula node', () => {
    const doc = formulaDoc('2+2');
    const { p, size } = formulaPos(doc);
    let state = EditorState.create({ doc, schema: S });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, p + size))); // caret right after chip
    const handled = unwrapFormulaBackspace(state, (tr) => { state = state.apply(tr); });
    expect(handled).toBe(true);
    expect(hasFormula(state)).toBe(false);
    expect(state.doc.child(1).textContent).toBe('2+2');
    expect(state.selection.empty).toBe(true); // caret left in the text to keep editing
  });
});

describe('Mechanic B — symmetric forward-Delete at the left edge (new)', () => {
  it('Delete right before a math chip → unwraps to "2+2", caret at the start of that text', () => {
    const doc = formulaDoc('2+2');
    const { p } = formulaPos(doc);
    let state = EditorState.create({ doc, schema: S });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, p))); // caret right before chip
    const handled = unwrapFormulaDelete(state, (tr) => { state = state.apply(tr); });
    expect(handled).toBe(true);
    expect(hasFormula(state)).toBe(false);
    expect(state.doc.child(1).textContent).toBe('2+2');
    expect(state.selection.from).toBe(p); // caret at the START of the unwrapped text
  });
});

describe('Mechanic B — the unwrapped text re-detects/re-renders via the EXISTING auto-detect', () => {
  it('after unwrap, typing "=" re-wraps "2+2" back into a math formula node', () => {
    const doc = formulaDoc('2+2');
    const { p, size } = formulaPos(doc);
    let state = EditorState.create({ doc, schema: S });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, p + size)));
    unwrapFormulaBackspace(state, (tr) => { state = state.apply(tr); }); // → "2+2" plain text, caret at end
    expect(hasFormula(state)).toBe(false);
    // re-trigger: the '=' auto path (a pipeline insert transform since [ROAD-0007] step 2) re-renders it
    const transforms = new TransformRegistry();
    registerFormulaTransforms(transforms, registry);
    const pos = state.selection.from;
    const reRan = runPreInsert(
      { state, dispatch: (tr) => { state = state.apply(tr); } },
      pos, pos, '=', transforms.insert,
    );
    expect(reRan).toBe(true);
    expect(hasFormula(state)).toBe(true);
    let spec = ''; state.doc.descendants((n) => { if (n.type.name === 'formula') spec = n.textContent; });
    expect(spec).toBe('2+2');
  });
});

describe('Mechanic B — additive, no regression', () => {
  it('both unwrap commands are inert when the caret is NOT at a formula edge', () => {
    const doc = S.node('doc', null, [
      S.node('title', { id: 't' }, [S.text('T')]),
      S.node('paragraph', { id: 'p' }, [S.text('hello')]),
    ]);
    let state = EditorState.create({ doc, schema: S });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 6)));
    expect(unwrapFormulaBackspace(state, () => {})).toBe(false);
    expect(unwrapFormulaDelete(state, () => {})).toBe(false);
  });

  it('hexcolor (the other ftype) unwraps too — type-generic, not math-specific', () => {
    const f = S.nodes['formula']!.create({ ftype: 'hexcolor', state: null }, S.text('#ff0000'));
    const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), S.node('paragraph', { id: 'p' }, [f])]);
    let state = EditorState.create({ doc, schema: S });
    let p = -1, size = 0;
    doc.descendants((n, pos) => { if (n.type.name === 'formula') { p = pos; size = n.nodeSize; } });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, p + size)));
    expect(unwrapFormulaBackspace(state, (tr) => { state = state.apply(tr); })).toBe(true);
    expect(state.doc.child(1).textContent).toBe('#ff0000');
  });
});
