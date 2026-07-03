/**
 * REGRESSION (the da33e2d guard): copy-OUT-of-deltos → paste-INTO-deltos for a LITERAL-TEXT note.
 *
 * The reported failure: a note whose `## Phase 1` / `- [ ] task` lines are stored as LITERAL characters
 * inside plain `paragraph` blocks (from an earlier bug — not real heading/todo nodes). Copying that note
 * OUT of deltos and pasting it back into a new note should convert the markdown to native blocks.
 *
 * Under step 4 the flow is MORE faithful than the old handlePaste test: an in-app copy puts PM's own
 * serialized HTML (data-pm-slice, literal text in plain <p>s) on the clipboard, and a real paste parses
 * THAT flavour. We drive `view.pasteHTML` — prosemirror-view's actual paste path — and the pipeline's
 * bulk leg converts the parsed literal paragraphs. (The old test injected text/plain past the html
 * flavour; the new architecture converts the html-parsed insertion itself, which is what really lands.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Slice, Fragment } from 'prosemirror-model';
import type { Node as PmNode } from 'prosemirror-model';
import type { Block, BlockBody, BlockId } from '@deltos/shared';
import { deltoSchema } from '../src/editor/schema.js';
import { spineToPmDoc, pmDocToSpine } from '../src/editor/serializer.js';
import { sliceToPlainText } from '../src/editor/clipboard.js';
import { buildEditorTransformRegistry } from '../src/editor/editorTransforms.js';
import { createDefaultFormulaRegistry } from '../src/plugins/formula/index.js';
import { buildInputPipelinePlugin } from '../src/editor/inputPipeline/index.js';
import { uniqueBlockIdPlugin } from '../src/editor/plugins/blockId.js';

const uuid = (n: number): BlockId =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111` as BlockId;

/**
 * The note as it is ACTUALLY stored: literal markdown characters inside plain paragraphs — NOT real
 * heading / todo nodes. This is the earlier-bug shape the user is copying out of deltos.
 */
const literalTextNote: BlockBody = [
  { id: uuid(1), type: 'paragraph', content: { segments: [{ text: '## Phase 1' }] } },
  { id: uuid(2), type: 'paragraph', content: { segments: [{ text: '- [ ] first task' }] } },
  { id: uuid(3), type: 'paragraph', content: { segments: [{ text: '- [x] done task' }] } },
];

/** Run the note through deltos's REAL copy serializer to get the text/plain the browser would carry. */
function copySerializeTextPlain(body: BlockBody): string {
  const doc = spineToPmDoc(deltoSchema, body, 'Title');
  const bodyNodes: PmNode[] = [];
  doc.forEach((node, _off, index) => { if (index > 0) bodyNodes.push(node); });
  return sliceToPlainText(new Slice(Fragment.fromArray(bodyNodes), 0, 0));
}

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; });

/** Mount a fresh note with the production pipeline and paste the given HTML flavour through doPaste. */
function pasteHtmlIntoFreshNote(html: string): BlockBody {
  const start: BlockBody = [{ id: uuid(99), type: 'paragraph', content: { segments: [] } }];
  const doc = spineToPmDoc(deltoSchema, start, 'Title');
  const registry = buildEditorTransformRegistry(deltoSchema, createDefaultFormulaRegistry());
  const state = EditorState.create({
    doc,
    selection: TextSelection.atEnd(doc),
    plugins: [buildInputPipelinePlugin(registry), uniqueBlockIdPlugin],
  });
  const mountPoint = document.createElement('div');
  document.body.appendChild(mountPoint);
  view = new EditorView(mountPoint, { state });
  view.pasteHTML(html, new Event('paste') as ClipboardEvent);
  return pmDocToSpine(view.state.doc);
}

describe('markdown paste — REAL in-app copy → paste of a literal-text note', () => {
  it('emits the literal markdown markers verbatim in text/plain (copy serializer evidence)', () => {
    const textPlain = copySerializeTextPlain(literalTextNote);
    expect(textPlain).toContain('## Phase 1');
    expect(textPlain).toContain('- [ ] first task');
    expect(textPlain).toContain('- [x] done task');
  });

  it('CONVERTS the pasted literal-text note into a heading + checked/unchecked todos', () => {
    // The html flavour PM's serializeForClipboard emits for literal-text paragraphs — the flavour a real
    // paste actually parses.
    const textHtml =
      '<div data-pm-slice="0 0 []"><p>## Phase 1</p><p>- [ ] first task</p><p>- [x] done task</p></div>';
    const body = pasteHtmlIntoFreshNote(textHtml);

    const heading = body.find((b) => b.type === 'heading');
    expect(heading).toBeTruthy();
    expect((heading!.content as { level: number }).level).toBe(2);

    const todos: Block[] = [];
    const walk = (bs: BlockBody) => bs.forEach((b) => { if (b.type === 'todo') todos.push(b); if (b.children) walk(b.children); });
    walk(body);
    expect(todos.map((t) => (t.content as { checked: boolean }).checked)).toEqual([false, true]);
    expect(todos.map((t) => (t.content as { segments: { text: string }[] }).segments[0]?.text)).toEqual([
      'first task',
      'done task',
    ]);
  });
});
