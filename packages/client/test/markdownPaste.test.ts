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
import type { Transaction } from 'prosemirror-state';
import { Slice, Fragment } from 'prosemirror-model';
import type { Node as PmNode } from 'prosemirror-model';
import type { Block, BlockBody, BlockId } from '@deltos/shared';
import { deltoSchema } from '../src/editor/schema.js';
import { spineToPmDoc, pmDocToSpine } from '../src/editor/serializer.js';
import { sliceToPlainText } from '../src/editor/clipboard.js';
import { markdownTextToSlice, buildMarkdownPastePlugin } from '../src/editor/markdownPaste.js';

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

// ── plugin structure-gate (the bug fix) ────────────────────────────────────────────────────────
//
// The `handlePaste` plugin used to DEFER on ANY non-empty `text/html` flavour — but almost every real copy
// carries one, so the markdown converter almost never fired. The gate now tests the plain text for markdown
// STRUCTURE and intercepts regardless of a `text/html` flavour. These run in the node env by driving the
// plugin's `handlePaste` prop directly with a minimal fake view (no DOM needed) + a fake clipboard event.
interface ClipOpts { html?: string; files?: File[] }
function clipEvent(text: string, opts: ClipOpts = {}): { clipboardData: DataTransfer } {
  return {
    clipboardData: {
      files: opts.files ?? [],
      getData: (t: string) => (t === 'text/html' ? (opts.html ?? '') : t === 'text/plain' ? text : ''),
    } as unknown as DataTransfer,
  };
}
/** Drive `text` through the real plugin handler; return whether it handled + the resulting spine. */
function driveGate(
  text: string,
  opts: ClipOpts = {},
  start: BlockBody = [{ id: uuid(99), type: 'paragraph', content: { segments: [] } }],
  inTitle = false,
): { handled: boolean; body: BlockBody } {
  const doc = spineToPmDoc(deltoSchema, start, 'Title');
  let state = EditorState.create({
    doc,
    selection: inTitle ? TextSelection.atStart(doc) : TextSelection.atEnd(doc),
  });
  const view = { get state() { return state; }, dispatch: (tr: Transaction) => { state = state.apply(tr); } };
  const handlePaste = buildMarkdownPastePlugin(deltoSchema).props.handlePaste!;
  const handled = handlePaste(
    view as unknown as Parameters<typeof handlePaste>[0],
    clipEvent(text, opts) as unknown as ClipboardEvent,
    Slice.empty,
  ) === true;
  return { handled, body: pmDocToSpine(state.doc) };
}

describe('markdown paste — plugin structure gate', () => {
  it('CONVERTS a markdown checklist even when a non-empty text/html flavour rides alongside (regression)', () => {
    // The bug: real clipboards attach text/html to almost every copy, and the old rule deferred on it.
    const { handled, body } = driveGate('## heading\n- [ ] a\n- [x] b', { html: '<p>## heading</p>' });
    expect(handled).toBe(true);
    const heading = body.find((b) => b.type === 'heading');
    expect((heading?.content as { level: number } | undefined)?.level).toBe(2);
    const todos: Block[] = [];
    const walk = (bs: BlockBody) => bs.forEach((b) => { if (b.type === 'todo') todos.push(b); if (b.children) walk(b.children); });
    walk(body);
    expect(todos.map((t) => (t.content as { checked: boolean }).checked)).toEqual([false, true]);
  });

  it('CONVERTS inline-mark-only markdown (a mark-bearing segment counts as structure)', () => {
    const { handled, body } = driveGate('some **bold** text', { html: '<p>some bold text</p>' });
    expect(handled).toBe(true);
    const para = body.find((b) => b.type === 'paragraph');
    const segs = (para?.content as { segments: { text: string; bold?: true }[] } | undefined)?.segments ?? [];
    expect(segs.some((s) => s.bold === true && s.text === 'bold')).toBe(true);
  });

  it('DEFERS a rich-web paste: text/html present + plain-prose text/plain (keeps the parseDOM path)', () => {
    const { handled } = driveGate('just some plain prose here', { html: '<b>just some plain prose here</b>' });
    expect(handled).toBe(false);
  });

  it('DEFERS plain prose with no html and no markdown (behavior change: was force-split before)', () => {
    const { handled } = driveGate('just some words and 2 * 3 numbers');
    expect(handled).toBe(false);
  });

  it('DEFERS a file paste (attachment plugin territory)', () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    expect(driveGate('## heading', { files: [file] }).handled).toBe(false);
  });

  it('DEFERS a lone bare URL (embeds card territory)', () => {
    expect(driveGate('https://example.com').handled).toBe(false);
  });

  it('DEFERS when the caret is in the title node', () => {
    expect(driveGate('## heading\n- [ ] a', {}, undefined, /* inTitle */ true).handled).toBe(false);
  });
});
