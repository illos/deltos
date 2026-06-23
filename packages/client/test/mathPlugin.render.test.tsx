/**
 * Inline-math EDITOR INTEGRATION tests (docs/specs/inline-math.md §3). A real ProseMirror EditorView with
 * the math plugins: the '=' trigger fires on a numeric tail / skips on prose, the live "= result"
 * decoration renders + recomputes on edit, div0/malformed shows the subtle error, and backspace at the
 * chip edge unwraps to plain text. Plus the spine round-trip preserves the `math` mark (persistence).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { deltoSchema } from '../src/editor/schema.js';
import { buildMathPlugins, unwrapMathBackspace } from '../src/plugins/math/mathPlugin.js';
import { spineToPmDoc, pmDocToSpine, type TextSegment } from '../src/editor/serializer.js';
import type { BlockBody } from '@deltos/shared';

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; document.body.innerHTML = ''; });

/** Mount an editor whose body paragraph contains `text`, caret at the end of that paragraph. */
function mountWithText(text: string): EditorView {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const para = deltoSchema.nodes['paragraph']!.create({ id: null }, text ? deltoSchema.text(text) : []);
  const title = deltoSchema.nodes['title']!.create({ id: null });
  const doc = deltoSchema.nodes['doc']!.create(null, [title, para]);
  let state = EditorState.create({ doc, plugins: buildMathPlugins(deltoSchema) });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  view = new EditorView(container, { state });
  return view;
}

/** Simulate typing a character at the caret through the input-rule path. */
function type(v: EditorView, ch: string): void {
  const { from } = v.state.selection;
  v.someProp('handleTextInput', (f) => f(v, from, from, ch));
}

/** The text carrying the `math` mark in the current doc (the persisted expression), or null. */
function mathText(v: EditorView): string | null {
  const mathType = deltoSchema.marks['math']!;
  let found: string | null = null;
  v.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((m) => m.type === mathType)) found = (found ?? '') + (node.text ?? '');
  });
  return found;
}

/** The rendered result value (the bold "= N"), or null if no result widget is present. */
const resultValue = (v: EditorView) => (v.dom.parentElement ?? document).querySelector('.math-result__value')?.textContent ?? null;
const hasErrorResult = (v: EditorView) => !!(v.dom.parentElement ?? document).querySelector('.math-result--error');

describe('inline-math plugin — the "=" trigger', () => {
  it('fires on a trailing numeric expression: marks it + shows the live result', () => {
    const v = mountWithText('1 + 1');
    type(v, '=');
    expect(mathText(v)).toBe('1 + 1'); // expression marked (the '=' itself is consumed)
    expect(resultValue(v)).toBe('2');  // decoration renders "= 2"
  });

  it('computes precedence + the x alias', () => {
    const v = mountWithText('1 + 4 - 2 / 10');
    type(v, '=');
    expect(resultValue(v)).toBe('4.8');
    const v2 = mountWithText('10 x 2');
    type(v2, '=');
    expect(resultValue(v2)).toBe('20');
  });

  it('fires mid-sentence on the trailing run only', () => {
    const v = mountWithText('I paid 10 x 2');
    type(v, '=');
    expect(mathText(v)).toBe('10 x 2'); // only the numeric tail is marked, not the prose
    expect(resultValue(v)).toBe('20');
  });

  it('does NOT fire on prose (the "=" types normally, no math mark, no result)', () => {
    const v = mountWithText('name = value'); // a fresh '=' after prose
    type(v, '=');
    expect(mathText(v)).toBeNull();
    expect(resultValue(v)).toBeNull();
  });
});

describe('inline-math plugin — live recompute + error state', () => {
  it('recomputes the result when the marked expression is edited', () => {
    const v = mountWithText('12 + 3');
    type(v, '=');
    expect(resultValue(v)).toBe('15');
    // delete the trailing '3' from inside the marked range → "12 + " → recompute
    const end = v.state.selection.from; // caret sits at the chip's right edge
    v.dispatch(v.state.tr.delete(end - 1, end));
    expect(resultValue(v)).toBeNull();   // no longer a valid result
    expect(hasErrorResult(v)).toBe(true); // subtle error shown instead (malformed, no crash)
  });

  it('shows a subtle error for division by zero (never crashes)', () => {
    // Build a doc that already has a math-marked "1 / 0" (as if persisted), via the spine round-trip.
    const body: BlockBody = [{
      id: 'b1' as BlockBody[number]['id'],
      type: 'paragraph',
      content: { segments: [{ text: '1 / 0', math: true } satisfies TextSegment] },
    }];
    const doc = spineToPmDoc(deltoSchema, body, '');
    const container = document.createElement('div');
    document.body.appendChild(container);
    view = new EditorView(container, { state: EditorState.create({ doc, plugins: buildMathPlugins(deltoSchema) }) });
    expect(resultValue(view)).toBeNull();
    expect(hasErrorResult(view)).toBe(true);
  });
});

describe('inline-math plugin — backspace-unwrap', () => {
  it('backspace at the chip right edge removes the math mark (back to plain text)', () => {
    const v = mountWithText('1 + 1');
    type(v, '=');
    expect(mathText(v)).toBe('1 + 1');
    const handled = unwrapMathBackspace(v.state, v.dispatch); // caret is at the chip's right edge
    expect(handled).toBe(true);
    expect(mathText(v)).toBeNull();       // unwrapped — mark gone
    expect(v.state.doc.textContent).toBe('1 + 1'); // text preserved (no char deleted on the unwrap)
    expect(resultValue(v)).toBeNull();    // result decoration gone
  });

  it('is a no-op (returns false) when the caret is not at a math chip', () => {
    const v = mountWithText('hello');
    expect(unwrapMathBackspace(v.state, v.dispatch)).toBe(false);
  });
});

describe('inline-math — spine round-trip preserves the math mark (persistence)', () => {
  it('the math expression survives pmDocToSpine → spineToPmDoc as marked text', () => {
    const body: BlockBody = [{
      id: 'b1' as BlockBody[number]['id'],
      type: 'paragraph',
      content: { segments: [{ text: '2 + 2', math: true } satisfies TextSegment] },
    }];
    const doc = spineToPmDoc(deltoSchema, body, '');
    const roundTripped = pmDocToSpine(doc);
    const seg = (roundTripped[0]!.content as { segments: TextSegment[] }).segments[0]!;
    expect(seg.text).toBe('2 + 2');
    expect(seg.math).toBe(true); // the mark persists (source of truth); the result is never stored
  });
});
