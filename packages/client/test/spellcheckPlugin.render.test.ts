/**
 * #69 §5 spellcheck — the editor adapter seam (deltos-side). The live decoration flow runs through the
 * worker (integration, on-device); here we cover the two pure seams without a worker:
 *  - eligibleBlocks: which textblocks get checked — title node + code_block EXCLUDED (acceptance).
 *  - applySpellCorrection: replacing a misspelled range with a suggestion in one transaction.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { deltoSchema } from '../src/editor/schema.js';
import { eligibleBlocks, applySpellCorrection } from '../src/editor/spellcheckPlugin.js';

const S = deltoSchema;

describe('eligibleBlocks — title + code_block excluded', () => {
  it('checks body paragraphs but not the title node or code blocks', () => {
    const doc = S.node('doc', null, [
      S.node('title', { id: 't' }, [S.text('Titel typo here')]),
      S.node('paragraph', { id: 'p1' }, [S.text('helo wrld')]),
      S.node('code_block', { id: 'c1' }, [S.text('consle.log(x)')]),
      S.node('paragraph', { id: 'p2' }, [S.text('anothr line')]),
    ]);
    const blocks = eligibleBlocks(doc);
    expect(blocks.map((b) => b.text)).toEqual(['helo wrld', 'anothr line']); // title + code_block skipped
    // Offsets point at each block's first character.
    for (const b of blocks) expect(doc.textBetween(b.from, b.from + b.text.length)).toBe(b.text);
  });
});

describe('applySpellCorrection — replace a range in one transaction', () => {
  let view: EditorView | null = null;
  afterEach(() => { view?.destroy(); view = null; });

  it('replaces the misspelled word with the chosen suggestion', () => {
    const doc = S.node('doc', null, [
      S.node('title', { id: 't' }, [S.text('T')]),
      S.node('paragraph', { id: 'p' }, [S.text('helo there')]),
    ]);
    view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc, schema: S }) });
    // 'helo' sits at the start of the body paragraph: title nodeSize 3 → paragraph content at 4, 'helo' 4..8.
    applySpellCorrection(view, 4, 8, 'hello');
    expect(view.state.doc.child(1).textContent).toBe('hello there');
  });
});
