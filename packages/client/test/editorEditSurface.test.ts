/**
 * The edit surface + registration order ([ROAD-0007] step 3).
 *
 * 1) ORDER TEST (design §5.4, load-bearing): the canonical assembly's registration order IS the execution
 *    order for insert matching and every compiled edit chain, and BOTH keyboards consume the same compiled
 *    chains — so this table is the single place a reordering must be made deliberately.
 *
 * 2) D3 — Backspace reverts the last auto-format (feel-flagged in editorTransforms.ts): one Backspace
 *    immediately after a conversion restores the literal trigger text, on the NATIVE keymap AND the Deck;
 *    a second Backspace deletes normally; any intervening edit/caret move closes the revert window.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { deltoSchema as S } from '../src/editor/schema.js';
import { buildEditorTransformRegistry, BACKSPACE_REVERTS_AUTOFORMAT } from '../src/editor/editorTransforms.js';
import { buildKeymap } from '../src/editor/keymap.js';
import { buildPmKeyActions } from '../src/editor/deckAdapter.js';
import { buildInputPipelinePlugin } from '../src/editor/inputPipeline/index.js';
import { createDefaultFormulaRegistry } from '../src/plugins/formula/index.js';
import { uniqueBlockIdPlugin } from '../src/editor/plugins/blockId.js';

const transforms = () => buildEditorTransformRegistry(S, createDefaultFormulaRegistry());

describe('registration order — §5.4 pinned (a reordering must edit THIS table deliberately)', () => {
  const r = transforms();
  it('insert: formula → bracket → absorb → markdown blocks → marks → autolink', () => {
    expect(r.insert.map((t) => t.id)).toEqual([
      'formula-auto-=', 'formula-auto-space', 'formula-bracket', 'formula-absorb',
      'md-h1', 'md-h2', 'md-h3', 'md-quote', 'md-codeblock', 'md-bullet', 'md-ordered', 'md-todo', 'md-divider',
      'md-bold', 'md-italic', 'md-strike', 'md-highlight', 'md-code',
      'autolink-scheme', 'autolink-bare',
    ]);
  });
  it('backspace chain: D3 revert → formula-unwrap → link-unwrap → atom-delete', () => {
    expect(r.backspace.map((t) => t.id)).toEqual(['undo-autoformat', 'formula-unwrap', 'link-unwrap', 'atom-delete']);
  });
  it('forward-delete chain: formula-unwrap-delete → atom-delete', () => {
    expect(r.forwardDelete.map((t) => t.id)).toEqual(['formula-unwrap-delete', 'atom-delete']);
  });
  it('enter boundary: formula-boundary-wrap → linkify (a trailing token is one or the other)', () => {
    expect(r.enterBoundary.map((t) => t.id)).toEqual(['formula-boundary-wrap', 'linkify']);
  });
  it('the D3 feel flag is ON (flip BACKSPACE_REVERTS_AUTOFORMAT to remove the behavior)', () => {
    expect(BACKSPACE_REVERTS_AUTOFORMAT).toBe(true);
  });
});

/** Real pipeline plugin state (the D3 record lives there) + blockId, over a view double. */
function makeView(paraText: string) {
  const t = transforms();
  const para = S.node('paragraph', { id: 'p' }, paraText ? [S.text(paraText)] : []);
  const doc = S.node('doc', null, [S.node('title', { id: 'ti' }, [S.text('T')]), para]);
  let state = EditorState.create({ doc, plugins: [buildInputPipelinePlugin(t), uniqueBlockIdPlugin] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)));
  const view = {
    get state() { return state; },
    dispatch: (tr: Transaction) => { state = state.apply(tr); },
    focus: () => {},
    composing: false,
    // joinBackward probes the DOM-backed block edge; the double has no DOM — report "not at the edge"
    // (block-start joins aren't what these tests assert).
    endOfTextblock: () => false,
  } as unknown as EditorView;
  const actions = buildPmKeyActions(() => view, t);
  const keys = buildKeymap(S, t);
  const hardwareBackspace = () => keys['Backspace']!(view.state, view.dispatch, view);
  return { view, actions, hardwareBackspace, body: () => view.state.doc.child(1) };
}

describe('D3 — Backspace reverts the last auto-format (both keyboards)', () => {
  it('DECK: "- " → bullet list, Backspace → literal "- " restored; second Backspace deletes a char', () => {
    const h = makeView('-');
    h.actions.insert(' '); // converts to a list (blockId mints wrapper ids in the same cycle)
    expect(h.body().type.name).toBe('bullet_list');
    h.actions.backspace(); // ONE backspace: revert to the literal trigger
    expect(h.body().type.name).toBe('paragraph');
    expect(h.body().textContent).toBe('- ');
    h.actions.backspace(); // the window closed: normal char delete
    expect(h.body().textContent).toBe('-');
  });

  it('HARDWARE: "# " → heading, keymap Backspace → literal "# " restored', () => {
    const h = makeView('#');
    h.actions.insert(' '); // (insert path is surface-agnostic; the revert is what we differentiate)
    expect(h.body().type.name).toBe('heading');
    h.hardwareBackspace();
    expect(h.body().type.name).toBe('paragraph');
    expect(h.body().textContent).toBe('# ');
  });

  it('an intervening keystroke closes the revert window (Backspace then deletes normally)', () => {
    const h = makeView('-');
    h.actions.insert(' ');
    expect(h.body().type.name).toBe('bullet_list');
    h.actions.insert('x'); // any other edit clears the record
    h.actions.backspace();
    expect(h.body().type.name).toBe('bullet_list'); // still a list — no revert
    expect(h.body().textContent).toBe(''); // the 'x' was deleted, one char, normally
  });

  it('a caret move closes the revert window', () => {
    const h = makeView('-');
    h.actions.insert(' ');
    h.actions.moveCaret(0, 0); // selection tr clears the record
    h.actions.backspace();
    expect(h.body().type.name).toBe('bullet_list'); // no revert
  });

  it('mark conversion reverts too: "**x**" → bold, Backspace → the literal delimiters return', () => {
    const h = makeView('**x*');
    h.actions.insert('*');
    let bold = false;
    h.body().forEach((c) => { if (c.marks.some((m) => m.type.name === 'bold')) bold = true; });
    expect(bold).toBe(true);
    h.actions.backspace();
    expect(h.body().textContent).toBe('**x**'); // literal restored, no bold
    let stillBold = false;
    h.body().forEach((c) => { if (c.marks.some((m) => m.type.name === 'bold')) stillBold = true; });
    expect(stillBold).toBe(false);
  });
});
