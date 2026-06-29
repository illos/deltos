/**
 * Block-object chrome — Mechanic A: plugin_block re-modelled from a BLOCK atom to an INLINE atom that renders
 * block-level. Proves: (1) caret-as-character, (2) single-press delete, (3) lossless spine round-trip,
 * (4) the migration shape (a top-level spine plugin block ⇒ a paragraph-wrapped inline atom on open, the
 * inverse on save). The mounted-editor DOM/selection behaviour (caret flanks, single-press delete tears the
 * NodeView down, the drag handle) is covered in blockObjectChrome.render.test.tsx; the Deck-path dual-wiring
 * (the same single-press delete through the keypad adapter, not the keymap) in deckBlockObjectDelete.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { BlockBody } from '@deltos/shared';
import { deltoSchema as S } from '../src/editor/schema.js';
import { spineToPmDoc, pmDocToSpine, extractTitleFromDoc } from '../src/editor/serializer.js';
import { deleteInlineAtomBackspace, deleteInlineAtomDelete } from '../src/editor/plugins/blockAtomChrome.js';

function atomDoc() {
  return S.node('doc', null, [
    S.node('title', { id: 't' }, [S.text('T')]),
    S.node('paragraph', { id: 'p' }, [
      S.node('plugin_block', { id: 'c', pluginType: 'attachment', pluginContent: { name: 'f.png' } }),
    ]),
  ]);
}
function atomPosOf(doc: ReturnType<typeof atomDoc>) {
  let p = -1;
  doc.descendants((n, pos) => { if (n.type.name === 'plugin_block') p = pos; });
  return p;
}

describe('Mechanic A — inline atom is a single character to the caret', () => {
  it('the schema node is an inline atom of size 1', () => {
    const t = S.nodes['plugin_block']!;
    expect(t.isAtom).toBe(true);
    expect(t.isInline).toBe(true);
    expect(t.isBlock).toBe(false);
    const doc = atomDoc();
    expect(doc.nodeAt(atomPosOf(doc))!.nodeSize).toBe(1); // one caret position wide
  });

  it('the caret can sit BEFORE the atom at the line start AND after it (impossible for a block atom)', () => {
    const doc = atomDoc();
    const at = atomPosOf(doc);
    const before = TextSelection.create(doc, at);       // immediately before the atom
    const after = TextSelection.create(doc, at + 1);    // immediately after the atom
    // Both cursors live INSIDE the wrapping paragraph (a textblock) — a real text position flanks the atom
    // on each side. A block atom has no text position before it at a line start; that was the whole problem.
    expect(before.$from.parent.type.name).toBe('paragraph');
    expect(after.$from.parent.type.name).toBe('paragraph');
    expect(after.$from.pos - before.$from.pos).toBe(1); // ArrowLeft/Right step across it as ONE position
  });

  it('Backspace right AFTER the atom deletes it as one unit (single press), leaving the line', () => {
    const doc = atomDoc();
    const at = atomPosOf(doc);
    let state = EditorState.create({ doc, schema: S });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at + 1)));
    const handled = deleteInlineAtomBackspace(state, (tr) => { state = state.apply(tr); });
    expect(handled).toBe(true);
    let present = false; state.doc.descendants((n) => { if (n.type.name === 'plugin_block') present = true; });
    expect(present).toBe(false);
    expect(state.doc.child(1).type.name).toBe('paragraph'); // empty line remains, caret on it
  });

  it('forward-Delete right BEFORE the atom deletes it as one unit (symmetric)', () => {
    const doc = atomDoc();
    const at = atomPosOf(doc);
    let state = EditorState.create({ doc, schema: S });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
    const handled = deleteInlineAtomDelete(state, (tr) => { state = state.apply(tr); });
    expect(handled).toBe(true);
    let present = false; state.doc.descendants((n) => { if (n.type.name === 'plugin_block') present = true; });
    expect(present).toBe(false);
  });

  it('the delete commands are inert when the caret is not flanking an atom (additive, no regression)', () => {
    const doc = S.node('doc', null, [
      S.node('title', { id: 't' }, [S.text('T')]),
      S.node('paragraph', { id: 'p' }, [S.text('hello')]),
    ]);
    let state = EditorState.create({ doc, schema: S });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 6))); // mid-text
    expect(deleteInlineAtomBackspace(state, () => {})).toBe(false);
    expect(deleteInlineAtomDelete(state, () => {})).toBe(false);
  });
});

describe('Mechanic A — migration shape + lossless round-trip (storage is the spine, not PM JSON)', () => {
  // The "migration" is the serializer itself: storage is the spine (top-level plugin Block, unchanged shape),
  // and spineToPmDoc rebuilds the PM doc on every open — wrapping the inline atom in a paragraph. So there is
  // NO stored-data migration and A6 (which migrates a plugin's PAYLOAD, not the doc tree) is not involved.
  // Block ids MUST be real UUIDs: pmDocToSpine now sanitizes the spine at its boundary (the render-only
  // id-leak fix), re-minting any non-UUID id. A friendly 'b1' would be re-minted and break the lossless
  // round-trip assertion below — so use real UUIDs (which is what production block ids always are).
  const legacy: BlockBody = [
    { id: '0b100000-0000-4000-8000-000000000001' as BlockBody[number]['id'], type: 'paragraph', content: { segments: [{ text: 'hello' }] } },
    { id: '0b100000-0000-4000-8000-000000000002' as BlockBody[number]['id'], type: 'attachment', content: { name: 'f.png', mime: 'image/png' } }, // a top-level plugin block
    { id: '0b100000-0000-4000-8000-000000000003' as BlockBody[number]['id'], type: 'paragraph', content: { segments: [{ text: 'world' }] } },
  ];

  it('spineToPmDoc wraps a top-level plugin block in a paragraph (the on-open migration)', () => {
    const doc = spineToPmDoc(S, legacy, 'Title');
    expect(extractTitleFromDoc(doc)).toBe('Title');
    const wrap = doc.child(2); // [title, para(hello), para(atom), para(world)]
    expect(wrap.type.name).toBe('paragraph');
    expect(wrap.childCount).toBe(1);
    expect(wrap.child(0).type.name).toBe('plugin_block');
    expect(wrap.child(0).attrs.pluginType).toBe('attachment');
    expect(wrap.child(0).attrs.pluginContent).toEqual({ name: 'f.png', mime: 'image/png' });
  });

  it('round-trips losslessly back to the original spine (isolated object, the normal case)', () => {
    const doc = spineToPmDoc(S, legacy, 'Title');
    const back = pmDocToSpine(doc);
    expect(back).toEqual(legacy);
  });

  it('a paragraph mixing text + atom + text splits into ordered spine blocks (documented caveat)', () => {
    // The user uses these as full-width line-owning objects, so this is an edge case; the spine model keeps
    // plugin blocks top-level, so a mixed line splits (content + order preserved, same-line grouping lost).
    const doc = S.node('doc', null, [
      S.node('title', { id: 't' }, [S.text('T')]),
      S.node('paragraph', { id: 'p' }, [
        S.text('a'),
        S.node('plugin_block', { id: '0b100000-0000-4000-8000-00000000000c', pluginType: 'attachment', pluginContent: { name: 'f.png' } }),
        S.text('b'),
      ]),
    ]);
    const back = pmDocToSpine(doc);
    expect(back.map((b) => b.type)).toEqual(['paragraph', 'attachment', 'paragraph']);
    expect(back[1]!.id).toBe('0b100000-0000-4000-8000-00000000000c'); // the atom's id (a valid UUID) survives
  });
});
