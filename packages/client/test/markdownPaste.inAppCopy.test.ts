/**
 * REGRESSION: copy-OUT-of-deltos → paste-INTO-deltos for a LITERAL-TEXT note.
 *
 * The reported failure: a note whose `## Phase 1` / `- [ ] task` lines are stored as LITERAL characters
 * inside plain `paragraph` blocks (from an earlier bug — not real heading/todo nodes). Copying that note
 * OUT of deltos and pasting it back into a new note should convert the markdown to native blocks.
 *
 * This suite reproduces the REAL flow faithfully:
 *   1. Build a PM doc whose body is literal-text paragraphs.
 *   2. Serialize text/plain with deltos's ACTUAL copy serializer (`sliceToPlainText`, wired as the editor's
 *      `clipboardTextSerializer`) + attach a realistic non-empty text/html flavour (what PM's
 *      serializeForClipboard would emit — the flavour that triggered the ORIGINAL "defer on html" bug).
 *   3. Feed that exact clipboard through the real `buildMarkdownPastePlugin` handlePaste handler.
 *   4. Assert whether it converts to a heading + todo_items.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import { Slice, Fragment } from 'prosemirror-model';
import type { Node as PmNode } from 'prosemirror-model';
import type { Block, BlockBody, BlockId } from '@deltos/shared';
import { deltoSchema } from '../src/editor/schema.js';
import { spineToPmDoc, pmDocToSpine } from '../src/editor/serializer.js';
import { sliceToPlainText } from '../src/editor/clipboard.js';
import { buildMarkdownPastePlugin } from '../src/editor/markdownPaste.js';

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

/** Drive a clipboard (text/plain + text/html) through the real handlePaste handler. */
function drivePaste(textPlain: string, textHtml: string): { handled: boolean; body: BlockBody } {
  const start: BlockBody = [{ id: uuid(99), type: 'paragraph', content: { segments: [] } }];
  const doc = spineToPmDoc(deltoSchema, start, 'Title');
  let state = EditorState.create({ doc, selection: TextSelection.atEnd(doc) });
  const view = { get state() { return state; }, dispatch: (tr: Transaction) => { state = state.apply(tr); } };
  const clipboardData = {
    files: [] as File[],
    getData: (t: string) => (t === 'text/html' ? textHtml : t === 'text/plain' ? textPlain : ''),
  } as unknown as DataTransfer;
  const handlePaste = buildMarkdownPastePlugin(deltoSchema).props.handlePaste!;
  const handled = handlePaste(
    view as unknown as Parameters<typeof handlePaste>[0],
    { clipboardData } as unknown as ClipboardEvent,
    Slice.empty,
  ) === true;
  return { handled, body: pmDocToSpine(state.doc) };
}

describe('markdown paste — REAL in-app copy → paste of a literal-text note', () => {
  it('emits the literal markdown markers verbatim in text/plain (copy serializer evidence)', () => {
    const textPlain = copySerializeTextPlain(literalTextNote);
    // eslint-disable-next-line no-console
    console.log('=== text/plain the copy serializer produced ===\n' + textPlain + '\n=== end ===');
    expect(textPlain).toContain('## Phase 1');
    expect(textPlain).toContain('- [ ] first task');
    expect(textPlain).toContain('- [x] done task');
  });

  it('CONVERTS the pasted literal-text note into a heading + checked/unchecked todos', () => {
    const textPlain = copySerializeTextPlain(literalTextNote);
    // A realistic non-empty text/html flavour, as PM's serializeForClipboard emits for literal-text paragraphs.
    const textHtml =
      '<div data-pm-slice="0 0 []"><p>## Phase 1</p><p>- [ ] first task</p><p>- [x] done task</p></div>';
    const { handled, body } = drivePaste(textPlain, textHtml);

    expect(handled).toBe(true);

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
