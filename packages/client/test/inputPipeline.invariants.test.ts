/**
 * THE GATING INVARIANT CORPUS ([ROAD-0007] design §2.3) — the permanent note-integrity regression net.
 * The unified input pipeline may convert ONLY transactions explicitly tagged as local user input; this
 * corpus feeds it every hostile ingress shape — the #90 reconcile (remote sync / MCP / history-restore),
 * undo/redo, IME composition, untagged programmatic inserts (the voice shape), blockId attr-only appends,
 * cut/drop — full of literal markdown, and asserts ZERO conversion. A positive control proves the corpus
 * isn't vacuous. THIS FILE MUST NEVER SHRINK: every case pins a silent-corruption vector.
 *
 * The corpus registers the REAL production transforms via the canonical assembly
 * (buildEditorTransformRegistry — the exact set + order the live editor runs, including the autolink
 * space rules as of step 3), so "zero output" means the rules were live and the GATE refused, not that
 * nothing was registered.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorState as PMState, Transaction } from 'prosemirror-state';
import { Slice, Fragment } from 'prosemirror-model';
import type { Node as PmNode } from 'prosemirror-model';
import { history, undo, redo } from 'prosemirror-history';
import { deltoSchema } from '../src/editor/schema.js';
import { buildEditorTransformRegistry } from '../src/editor/editorTransforms.js';
import { createDefaultFormulaRegistry } from '../src/plugins/formula/index.js';
import { uniqueBlockIdPlugin } from '../src/editor/plugins/blockId.js';
import type {
  TransformRegistry} from '../src/editor/inputPipeline/index.js';
import {
  buildInputPipelinePlugin,
  inputPipelineTag,
} from '../src/editor/inputPipeline/index.js';

const S = deltoSchema;

/** The literals another device could sync in — each is a live trigger for some current/future transform. */
const HOSTILE_LITERALS = ['[ ] buy milk', '# not a heading', '**x** stays literal', '=1+1=', 'see https://example.com now'];

const formulaRegistry = createDefaultFormulaRegistry();

function corpusRegistry(): TransformRegistry {
  return buildEditorTransformRegistry(S, formulaRegistry); // THE production set + §5.4 order, verbatim
}

/** title + one paragraph, caret at the paragraph's end, pipeline + history + blockId live. */
function makeState(paraText: string): PMState {
  const para = S.node('paragraph', { id: 'p' }, paraText ? [S.text(paraText)] : []);
  const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), para]);
  let state = EditorState.create({
    doc,
    plugins: [buildInputPipelinePlugin(corpusRegistry()), history(), uniqueBlockIdPlugin],
  });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)));
  return state;
}

function hostileParas(): PmNode[] {
  return HOSTILE_LITERALS.map((t, i) => S.node('paragraph', { id: `h${i}` }, [S.text(t)]));
}

/** No transform output anywhere: no todo/heading blocks, no formula chips, no bold text, and — now that
 *  the autolink rules are live in the registry (step 3) — no LINK mark on the corpus's bare URL either. */
function assertNoConversion(state: PMState): void {
  state.doc.descendants((node) => {
    expect(node.type.name).not.toBe('todo_item');
    expect(node.type.name).not.toBe('heading');
    expect(node.type.name).not.toBe('formula');
    expect(node.marks.some((m) => m.type.name === 'bold')).toBe(false);
    expect(node.marks.some((m) => m.type.name === 'link')).toBe(false);
  });
  for (const literal of HOSTILE_LITERALS) expect(state.doc.textContent).toContain(literal);
}

describe('input pipeline — POSITIVE CONTROL (the corpus is not vacuous)', () => {
  it('a properly tagged deck insertion converts ("[ ] " → todo_item)', () => {
    let state = makeState('[ ]');
    state = state.apply(state.tr.insertText(' ').setMeta(inputPipelineTag, { kind: 'deck', text: ' ' }));
    expect(state.doc.child(1).type.name).toBe('todo_item');
  });

  it('the formula rules are live too: a tagged "=" after "1 + 1" converts to a formula chip', () => {
    let state = makeState('1 + 1');
    state = state.apply(state.tr.insertText('=').setMeta(inputPipelineTag, { kind: 'deck', text: '=' }));
    let formula = false;
    state.doc.descendants((n) => { if (n.type.name === 'formula') formula = true; });
    expect(formula).toBe(true);
  });

  it('undo restores the literal in one step and does NOT re-convert; redo re-applies', () => {
    let state = makeState('[ ]');
    state = state.apply(state.tr.insertText(' ').setMeta(inputPipelineTag, { kind: 'deck', text: ' ' }));
    expect(state.doc.child(1).type.name).toBe('todo_item');
    undo(state, (tr) => { state = state.apply(tr); });
    // The undo tr carries history meta AND no tag → the pipeline must not touch the restored literal.
    // Trigger insert + appended transform share one history group (§5.1): one undo lands BEFORE the space.
    expect(state.doc.child(1).type.name).toBe('paragraph');
    expect(state.doc.child(1).textContent).toBe('[ ]');
    redo(state, (tr) => { state = state.apply(tr); });
    expect(state.doc.child(1).type.name).toBe('todo_item');
  });
});

describe('input pipeline — hostile ingresses convert NOTHING', () => {
  it('load path: EditorState.create with literal markdown leaves the doc untouched (structurally invisible)', () => {
    const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), ...hostileParas()]);
    const state = EditorState.create({
      doc,
      plugins: [buildInputPipelinePlugin(corpusRegistry()), history(), uniqueBlockIdPlugin],
    });
    assertNoConversion(state);
  });

  it('the #90 reconcile shape (whole-doc replaceWith + reconcile + addToHistory:false) stays literal', () => {
    let state = makeState('old content');
    const title = S.node('title', { id: 't' }, [S.text('T')]);
    const tr = state.tr
      .replaceWith(0, state.doc.content.size, [title, ...hostileParas()])
      .setMeta('reconcile', true)
      .setMeta('addToHistory', false);
    state = state.apply(tr);
    assertNoConversion(state);
  });

  it('the untagged voice shape — insertText("[ ] ") with no meta — stays literal', () => {
    let state = makeState('');
    state = state.apply(state.tr.insertText('[ ] buy milk'));
    expect(state.doc.child(1).type.name).toBe('paragraph');
    expect(state.doc.child(1).textContent).toBe('[ ] buy milk');
  });

  it('an untagged composition insert stays literal', () => {
    let state = makeState('#');
    state = state.apply(state.tr.insertText(' ').setMeta('composition', 1));
    expect(state.doc.child(1).type.name).toBe('paragraph');
  });

  it('a blockId attr-only append cycle produces no pipeline output (untagged insert of a literal block)', () => {
    let state = makeState('x');
    const para = S.node('paragraph', { id: null }, [S.text('# not a heading')]);
    state = state.apply(state.tr.insert(state.doc.content.size, para));
    const inserted = state.doc.child(2);
    expect(inserted.type.name).toBe('paragraph'); // literal survived
    expect(inserted.attrs.id).toBeTruthy(); // blockId's own appendTransaction still minted the id
  });
});

describe('input pipeline — the BELT (even a tagged tr is refused when a hostile meta rides it)', () => {
  /** '[ ]' + tagged space would convert (the positive control) — each belt meta must block exactly that. */
  function beltCase(decorate: (tr: Transaction) => Transaction): PMState {
    let state = makeState('[ ]');
    const tr = decorate(state.tr.insertText(' ').setMeta(inputPipelineTag, { kind: 'deck', text: ' ' }));
    state = state.apply(tr);
    return state;
  }

  it('tag + reconcile → refused', () => {
    expect(beltCase((tr) => tr.setMeta('reconcile', true)).doc.child(1).type.name).toBe('paragraph');
  });
  it('tag + addToHistory:false → refused', () => {
    expect(beltCase((tr) => tr.setMeta('addToHistory', false)).doc.child(1).type.name).toBe('paragraph');
  });
  it('tag + history meta → refused', () => {
    expect(beltCase((tr) => tr.setMeta('history$', {})).doc.child(1).type.name).toBe('paragraph');
  });
  it('tag + composition → refused', () => {
    expect(beltCase((tr) => tr.setMeta('composition', 0)).doc.child(1).type.name).toBe('paragraph');
  });
  it("tag + uiEvent:'cut' → refused", () => {
    expect(beltCase((tr) => tr.setMeta('uiEvent', 'cut')).doc.child(1).type.name).toBe('paragraph');
  });
  it("tag + uiEvent:'drop' → refused", () => {
    expect(beltCase((tr) => tr.setMeta('uiEvent', 'drop')).doc.child(1).type.name).toBe('paragraph');
  });
  it("the pipeline's own 'applied' tag never re-enters (loop guard)", () => {
    let state = makeState('[ ]');
    state = state.apply(state.tr.insertText(' ').setMeta(inputPipelineTag, { kind: 'applied' }));
    expect(state.doc.child(1).type.name).toBe('paragraph');
  });
});

describe('input pipeline — the step-4 PASTE bulk leg (implicit uiEvent tag; corpus EXTENDS, never shrinks)', () => {
  /** PM's default plain-text paste, faithfully: one paragraph per line (parseFromClipboard's split),
   *  replaceSelection, dispatched with the metas doPaste sets — the implicit shape the gate accepts. */
  function pmDefaultPaste(state: PMState, text: string, extraMeta?: [string, unknown]): PMState {
    const paras = text
      .split(/(?:\r\n?|\n)+/)
      .map((line) => S.node('paragraph', { id: null }, line ? [S.text(line)] : []));
    let tr = state.tr
      .replaceSelection(new Slice(Fragment.fromArray(paras), 1, 1))
      .setMeta('paste', true)
      .setMeta('uiEvent', 'paste');
    if (extraMeta) tr = tr.setMeta(extraMeta[0], extraMeta[1]);
    return state.apply(tr);
  }

  function shape(state: PMState): { heading: boolean; todo: boolean } {
    let heading = false;
    let todo = false;
    state.doc.descendants((n) => {
      if (n.type.name === 'heading') heading = true;
      if (n.type.name === 'todo_item') todo = true;
    });
    return { heading, todo };
  }

  it("POSITIVE CONTROL: a uiEvent:'paste' insertion of literal markdown CONVERTS (the bulk leg is live)", () => {
    let state = makeState('');
    state = pmDefaultPaste(state, '## Phase\n- [ ] a');
    expect(shape(state)).toEqual({ heading: true, todo: true });
    expect(state.doc.textContent).not.toContain('## Phase');
  });

  it("a uiEvent:'paste' insertion of RICH (marked) content is NOT re-parsed (rich-slice guard)", () => {
    let state = makeState('');
    const bold = S.node('paragraph', { id: null }, [S.text('**x** stays as typed', [S.marks['bold']!.create()])]);
    state = state.apply(
      state.tr
        .replaceSelection(new Slice(Fragment.from(bold), 1, 1))
        .setMeta('paste', true)
        .setMeta('uiEvent', 'paste'),
    );
    // The literal '**x**' inside already-bold text must survive — a rich paste is never re-parsed.
    expect(state.doc.textContent).toContain('**x** stays as typed');
    expect(shape(state)).toEqual({ heading: false, todo: false });
  });

  it("bulk-shaped insertions under uiEvent 'cut' / 'drop' stay literal", () => {
    for (const ui of ['cut', 'drop']) {
      let state = makeState('');
      const para = S.node('paragraph', { id: null }, [S.text('# not a heading')]);
      state = state.apply(
        state.tr.replaceSelection(new Slice(Fragment.from(para), 1, 1)).setMeta('uiEvent', ui),
      );
      expect(state.doc.textContent).toContain('# not a heading');
      expect(shape(state).heading).toBe(false);
    }
  });

  it('a paste-shaped tr carrying reconcile is refused (belt over the bulk leg)', () => {
    let state = makeState('');
    state = pmDefaultPaste(state, '## Phase\n- [ ] a', ['reconcile', true]);
    expect(state.doc.textContent).toContain('## Phase');
    expect(shape(state)).toEqual({ heading: false, todo: false });
  });

  it('a paste into a CODE BLOCK stays literal (code-zone guard)', () => {
    const code = S.node('code_block', { id: 'c' }, [S.text('existing')]);
    const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), code]);
    let state = EditorState.create({
      doc,
      plugins: [buildInputPipelinePlugin(corpusRegistry()), history(), uniqueBlockIdPlugin],
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)));
    // PM's real paste into a code block inserts the RAW text (parseFromClipboard's inCode branch).
    state = state.apply(
      state.tr.insertText('# h\n- [ ] a').setMeta('paste', true).setMeta('uiEvent', 'paste'),
    );
    expect(shape(state)).toEqual({ heading: false, todo: false });
    expect(state.doc.child(1).textContent).toContain('# h');
  });

  it('ONE undo reverts the paste insert + its conversion together (§5.1 same history group)', () => {
    let state = makeState('');
    state = pmDefaultPaste(state, '## Phase\n- [ ] a');
    expect(shape(state)).toEqual({ heading: true, todo: true });
    undo(state, (tr) => { state = state.apply(tr); });
    expect(shape(state)).toEqual({ heading: false, todo: false });
    expect(state.doc.textContent).not.toContain('## Phase');
    redo(state, (tr) => { state = state.apply(tr); });
    expect(shape(state)).toEqual({ heading: true, todo: true });
  });
});
