/**
 * THE GATING INVARIANT CORPUS ([ROAD-0007] design §2.3) — the permanent note-integrity regression net.
 * The unified input pipeline may convert ONLY transactions explicitly tagged as local user input; this
 * corpus feeds it every hostile ingress shape — the #90 reconcile (remote sync / MCP / history-restore),
 * undo/redo, IME composition, untagged programmatic inserts (the voice shape), blockId attr-only appends,
 * cut/drop — full of literal markdown, and asserts ZERO conversion. A positive control proves the corpus
 * isn't vacuous. THIS FILE MUST NEVER SHRINK: every case pins a silent-corruption vector.
 *
 * The corpus registers the REAL production markdown transforms (registerMarkdownTransforms — the exact
 * set the live editor runs), so "zero output" means the rules were live and the GATE refused, not that
 * nothing was registered. As later migration steps register formula/autolink, this net covers them too.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorState as PMState, Transaction } from 'prosemirror-state';
import type { Node as PmNode } from 'prosemirror-model';
import { history, undo, redo } from 'prosemirror-history';
import { deltoSchema } from '../src/editor/schema.js';
import { registerMarkdownTransforms } from '../src/editor/inputRules.js';
import { uniqueBlockIdPlugin } from '../src/editor/plugins/blockId.js';
import {
  TransformRegistry,
  buildInputPipelinePlugin,
  inputPipelineTag,
} from '../src/editor/inputPipeline/index.js';

const S = deltoSchema;

/** The literals another device could sync in — each is a live trigger for some current/future transform. */
const HOSTILE_LITERALS = ['[ ] buy milk', '# not a heading', '**x** stays literal', '=1+1=', 'see https://example.com now'];

function corpusRegistry(): TransformRegistry {
  const r = new TransformRegistry();
  registerMarkdownTransforms(r, S);
  return r;
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

/** No transform output anywhere: no todo/heading blocks, no bold text, every literal intact. */
function assertNoConversion(state: PMState): void {
  state.doc.descendants((node) => {
    expect(node.type.name).not.toBe('todo_item');
    expect(node.type.name).not.toBe('heading');
    expect(node.marks.some((m) => m.type.name === 'bold')).toBe(false);
  });
  for (const literal of HOSTILE_LITERALS) expect(state.doc.textContent).toContain(literal);
}

describe('input pipeline — POSITIVE CONTROL (the corpus is not vacuous)', () => {
  it('a properly tagged deck insertion converts ("[ ] " → todo_item)', () => {
    let state = makeState('[ ]');
    state = state.apply(state.tr.insertText(' ').setMeta(inputPipelineTag, { kind: 'deck', text: ' ' }));
    expect(state.doc.child(1).type.name).toBe('todo_item');
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
