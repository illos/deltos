/**
 * Plain-text markdown paste (editor md-paste). The copy serializer (clipboard.ts nodeToText) EMITS
 * markdown; markdownToBody (shared) parses it back; this suite proves the paste path reuses both losslessly.
 *
 * Key correctness test: copy ↔ paste round-trip — a doc with heading + todo + list + quote + bold serialized
 * to text (copy) and pasted back reproduces the SAME spine (block ids aside). Plus the conservative-insertion
 * behaviours (inline snippet stays inline; block markdown becomes blocks; no ghost leading paragraph).
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Slice, Fragment } from 'prosemirror-model';
import type { Node as PmNode } from 'prosemirror-model';
import type { Block, BlockBody, BlockId } from '@deltos/shared';
import { deltoSchema } from '../src/editor/schema.js';
import { spineToPmDoc, pmDocToSpine } from '../src/editor/serializer.js';
import { sliceToPlainText } from '../src/editor/clipboard.js';
import { markdownTextToSlice } from '../src/editor/markdownPaste.js';
import { buildEditorTransformRegistry } from '../src/editor/editorTransforms.js';
import { createDefaultFormulaRegistry } from '../src/plugins/formula/index.js';
import { buildInputPipelinePlugin } from '../src/editor/inputPipeline/index.js';
import { uniqueBlockIdPlugin } from '../src/editor/plugins/blockId.js';

const uuid = (n: number): BlockId =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111` as BlockId;

/** Recursively drop server-minted ids so structural equality survives the fresh UUIDs markdownToBody mints. */
function stripIds(blocks: BlockBody): unknown[] {
  return blocks.map((b: Block) => {
    const { id: _id, children, ...rest } = b;
    return children ? { ...rest, children: stripIds(children) } : { ...rest };
  });
}

/** Serialize a full spine body to the markdown the COPY path would put on the clipboard (text/plain). */
function copyToMarkdown(body: BlockBody): string {
  const doc = spineToPmDoc(deltoSchema, body, 'Title');
  const bodyNodes: PmNode[] = [];
  doc.forEach((node, _off, index) => { if (index > 0) bodyNodes.push(node); });
  return sliceToPlainText(new Slice(Fragment.fromArray(bodyNodes), 0, 0));
}

/** Start a fresh single-empty-paragraph note and PASTE `text` at the end (the real handler's dispatch). */
function pasteInto(text: string, start: BlockBody = [{ id: uuid(99), type: 'paragraph', content: { segments: [] } }]): BlockBody {
  const startDoc = spineToPmDoc(deltoSchema, start, 'Title');
  let state = EditorState.create({ doc: startDoc, selection: TextSelection.atEnd(startDoc) });
  const slice = markdownTextToSlice(deltoSchema, text);
  if (slice) state = state.apply(state.tr.replaceSelection(slice));
  return pmDocToSpine(state.doc);
}

// A rich body: heading + todo + bullet list + quote + a bold inline run.
const richBody: BlockBody = [
  { id: uuid(1), type: 'heading', content: { level: 2, segments: [{ text: 'Phase' }] } },
  { id: uuid(2), type: 'todo', content: { checked: false, segments: [{ text: 'a' }] } },
  { id: uuid(3), type: 'todo', content: { checked: true, segments: [{ text: 'b' }] } },
  {
    id: uuid(4), type: 'list', content: { ordered: false }, children: [
      { id: uuid(5), type: 'paragraph', content: { segments: [{ text: 'one' }] } },
      { id: uuid(6), type: 'paragraph', content: { segments: [{ text: 'two' }] } },
    ],
  },
  { id: uuid(7), type: 'quote', content: { segments: [{ text: 'wisdom' }] } },
  { id: uuid(8), type: 'paragraph', content: { segments: [{ text: 'plain ' }, { text: 'bold', bold: true }] } },
];

describe('markdown paste — copy ↔ paste round-trip (lossless)', () => {
  it('reproduces the original spine after copy → paste (ids aside)', () => {
    const md = copyToMarkdown(richBody);
    const result = pasteInto(md);
    expect(stripIds(result)).toEqual(stripIds(richBody));
  });

  it('leaves NO ghost leading paragraph when pasting a block document into an empty note', () => {
    const md = copyToMarkdown(richBody);
    const result = pasteInto(md);
    // First block is the heading — the empty target paragraph must have been replaced, not kept.
    expect(result[0]?.type).toBe('heading');
    expect(result.length).toBe(richBody.length);
  });
});

describe('markdown paste — checklist', () => {
  it('a "## Phase" heading + [ ]/[x] todos become a heading + checked/unchecked todo blocks', () => {
    const result = pasteInto('## Phase\n- [ ] a\n- [x] b');
    const heading = result.find((b) => b.type === 'heading');
    expect(heading).toBeTruthy();
    expect((heading!.content as { level: number }).level).toBe(2);
    // The list items are todos carrying the correct checked state.
    const todos: Block[] = [];
    const walk = (bs: BlockBody) => bs.forEach((b) => { if (b.type === 'todo') todos.push(b); if (b.children) walk(b.children); });
    walk(result);
    expect(todos.map((t) => (t.content as { checked: boolean }).checked)).toEqual([false, true]);
    expect(todos.map((t) => (t.content as { segments: { text: string }[] }).segments[0]?.text)).toEqual(['a', 'b']);
  });
});

describe('markdown paste — conservative plain prose', () => {
  it('a single inline snippet pastes inline (no paragraph split, no extra blocks)', () => {
    // Start non-empty so an inline merge is observable: paste "world" after "hello ".
    const result = pasteInto('world', [{ id: uuid(50), type: 'paragraph', content: { segments: [{ text: 'hello ' }] } }]);
    expect(result.length).toBe(1);
    expect(result[0]?.type).toBe('paragraph');
    const text = (result[0]!.content as { segments: { text: string }[] }).segments.map((s) => s.text).join('');
    expect(text).toBe('hello world');
  });

  it('blank-line-separated prose becomes two paragraphs with no extra blank/empty blocks', () => {
    const result = pasteInto('first para\n\nsecond para');
    expect(result.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
    const texts = result.map((b) => (b.content as { segments: { text: string }[] }).segments.map((s) => s.text).join(''));
    expect(texts).toEqual(['first para', 'second para']);
  });

  it('plain prose with no markdown produces no literal artifacts', () => {
    const result = pasteInto('just some words and 2 * 3 numbers', [{ id: uuid(51), type: 'paragraph', content: { segments: [] } }]);
    expect(result.length).toBe(1);
    const text = (result[0]!.content as { segments: { text: string }[] }).segments.map((s) => s.text).join('');
    expect(text).toBe('just some words and 2 * 3 numbers');
  });
});

describe('markdownTextToSlice — open-depth shape', () => {
  it('a single paragraph is fully open (openStart/openEnd = 1) so it merges inline', () => {
    const slice = markdownTextToSlice(deltoSchema, 'hello world')!;
    expect(slice.openStart).toBe(1);
    expect(slice.openEnd).toBe(1);
  });

  it('a leading heading keeps a closed start so it stays a full block', () => {
    const slice = markdownTextToSlice(deltoSchema, '# Title\nbody')!;
    expect(slice.openStart).toBe(0);
    expect(slice.content.firstChild?.type.name).toBe('heading');
  });

  it('whitespace-only text yields no slice (falls through to default paste)', () => {
    expect(markdownTextToSlice(deltoSchema, '   \n  ')).toBeNull();
  });
});

// ── the bulk-leg structure gate (the bug fix, now pipeline-shaped) ─────────────────────────────
//
// The old `handlePaste` plugin deferred on ANY non-empty `text/html` flavour — but almost every real copy
// carries one, so the markdown converter almost never fired. Step 4 moves conversion to the pipeline's
// appendTransaction bulk leg: PM's default paste inserts the content (whichever flavour it picked), and
// the bulk transform inspects the INSERTED RANGE — plain unmarked paragraphs carrying markdown structure
// convert; anything already structured/marked (a genuinely rich paste) is skipped. Flavour-independence is
// now a property of the CONTENT, not of clipboard sniffing. These drive the leg with faithfully-shaped
// transactions (PM's line-per-paragraph plain-text paste + `uiEvent:'paste'` meta), no DOM needed.
const pipelineRegistry = () => buildEditorTransformRegistry(deltoSchema, createDefaultFormulaRegistry());

function pasteState(start: BlockBody, inTitle: boolean) {
  const doc = spineToPmDoc(deltoSchema, start, 'Title');
  return EditorState.create({
    doc,
    selection: inTitle ? TextSelection.atStart(doc) : TextSelection.atEnd(doc),
    plugins: [buildInputPipelinePlugin(pipelineRegistry()), uniqueBlockIdPlugin],
  });
}

/** PM's default PLAIN-TEXT paste, faithfully: one paragraph per line, replaceSelection, doPaste's metas. */
function drivePlainPaste(
  text: string,
  start: BlockBody = [{ id: uuid(99), type: 'paragraph', content: { segments: [] } }],
  inTitle = false,
): BlockBody {
  let state = pasteState(start, inTitle);
  const paras = text
    .split(/(?:\r\n?|\n)+/)
    .map((line) => deltoSchema.node('paragraph', { id: null }, line ? [deltoSchema.text(line)] : []));
  state = state.apply(
    state.tr
      .replaceSelection(new Slice(Fragment.fromArray(paras), 1, 1))
      .setMeta('paste', true)
      .setMeta('uiEvent', 'paste'),
  );
  return pmDocToSpine(state.doc);
}

const collectTodos = (bs: BlockBody): Block[] => {
  const todos: Block[] = [];
  const walk = (b: BlockBody) => b.forEach((x) => { if (x.type === 'todo') todos.push(x); if (x.children) walk(x.children); });
  walk(bs);
  return todos;
};

describe('markdown paste — the bulk-leg structure gate', () => {
  it('CONVERTS a markdown checklist delivered as PM default plain-paragraph insertion (regression: flavour-independent)', () => {
    const body = drivePlainPaste('## heading\n- [ ] a\n- [x] b');
    const heading = body.find((b) => b.type === 'heading');
    expect((heading?.content as { level: number } | undefined)?.level).toBe(2);
    expect(collectTodos(body).map((t) => (t.content as { checked: boolean }).checked)).toEqual([false, true]);
  });

  it('CONVERTS inline-mark-only markdown (a mark-bearing segment counts as structure)', () => {
    const body = drivePlainPaste('some **bold** text');
    const para = body.find((b) => b.type === 'paragraph');
    const segs = (para?.content as { segments: { text: string; bold?: true }[] } | undefined)?.segments ?? [];
    expect(segs.some((s) => s.bold === true && s.text === 'bold')).toBe(true);
  });

  it('SKIPS an already-structured (rich) insertion — a real rich-web paste is never re-parsed', () => {
    // What a rich `<b>…</b>` HTML paste inserts: text already carrying the bold mark.
    let state = pasteState([{ id: uuid(99), type: 'paragraph', content: { segments: [] } }], false);
    const para = deltoSchema.node('paragraph', { id: null }, [
      deltoSchema.text('looks like **markdown** but is rich', [deltoSchema.marks['bold']!.create()]),
    ]);
    state = state.apply(
      state.tr
        .replaceSelection(new Slice(Fragment.from(para), 1, 1))
        .setMeta('paste', true)
        .setMeta('uiEvent', 'paste'),
    );
    // Literal '**markdown**' survives inside the bold run — no re-parse, no double conversion.
    expect(state.doc.textContent).toContain('**markdown**');
    expect(pmDocToSpine(state.doc).some((b) => b.type === 'heading' || b.type === 'todo')).toBe(false);
  });

  it('SKIPS plain prose with no markdown structure (stays exactly as the default paste left it)', () => {
    const body = drivePlainPaste('just some words and 2 * 3 numbers');
    expect(body.map((b) => b.type)).toEqual(['paragraph']);
    const text = (body[0]!.content as { segments: { text: string }[] }).segments.map((s) => s.text).join('');
    expect(text).toBe('just some words and 2 * 3 numbers');
  });

  it('SKIPS a non-text insertion (a pasted atom/divider — the file/attachment class)', () => {
    let state = pasteState([{ id: uuid(99), type: 'paragraph', content: { segments: [] } }], false);
    const divider = deltoSchema.node('horizontal_rule', { id: null });
    state = state.apply(
      state.tr
        .replaceSelection(new Slice(Fragment.from(divider), 0, 0))
        .setMeta('paste', true)
        .setMeta('uiEvent', 'paste'),
    );
    const body = pmDocToSpine(state.doc);
    expect(body.some((b) => b.type === 'divider')).toBe(true);
    expect(body.some((b) => b.type === 'heading' || b.type === 'todo')).toBe(false);
  });

  it('SKIPS a lone bare URL (embeds card territory — stays literal for its handler)', () => {
    const body = drivePlainPaste('https://example.com');
    expect(body.map((b) => b.type)).toEqual(['paragraph']);
    const segs = (body[0]!.content as { segments: { text: string; link?: string }[] }).segments;
    expect(segs[0]?.text).toBe('https://example.com');
    expect(segs.some((s) => s.link)).toBe(false);
  });

  it('SKIPS when the insertion lands in the title node (title paste stays plain)', () => {
    const body = drivePlainPaste('## heading\n- [ ] a', undefined, /* inTitle */ true);
    expect(body.some((b) => b.type === 'heading' || b.type === 'todo')).toBe(false);
  });
});
