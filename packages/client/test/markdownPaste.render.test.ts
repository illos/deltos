/**
 * Mount-level md-paste test (ui-features-need-rendered-ui-gate): a REAL EditorView with the markdown-paste
 * plugin. Proves pasting plain-text markdown renders as real nodes in the editor DOM — even when a
 * `text/html` flavour rides alongside (the real-clipboard case) — and that the guard paths (rich-web HTML
 * paste whose text is bare prose / files / a lone URL / the title node) return false = default paste.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Slice } from 'prosemirror-model';
import type { BlockBody, BlockId } from '@deltos/shared';
import { deltoSchema } from '../src/editor/schema.js';
import { spineToPmDoc } from '../src/editor/serializer.js';
import { buildMarkdownPastePlugin } from '../src/editor/markdownPaste.js';

const P0: BlockId = '00000000-1111-4111-8111-111111111111' as BlockId;
const EMPTY: BlockBody = [{ id: P0, type: 'paragraph', content: { segments: [] } }];

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; });

/** Mount a real EditorView with ONLY the md-paste plugin; caret in the body unless `inTitle`. */
function mount(body: BlockBody = EMPTY, inTitle = false): EditorView {
  const doc = spineToPmDoc(deltoSchema, body, 'Title');
  const selection = inTitle ? TextSelection.atStart(doc) : TextSelection.atEnd(doc);
  const state = EditorState.create({ doc, selection, plugins: [buildMarkdownPastePlugin(deltoSchema)] });
  const mountPoint = document.createElement('div');
  document.body.appendChild(mountPoint);
  view = new EditorView(mountPoint, { state });
  return view;
}

interface ClipOpts { html?: string; files?: File[] }
/** Minimal ClipboardEvent stand-in carrying the flavours the handler inspects. */
function clip(text: string, opts: ClipOpts = {}): ClipboardEvent {
  return {
    clipboardData: {
      files: opts.files ?? [],
      getData: (t: string) => (t === 'text/html' ? (opts.html ?? '') : t === 'text/plain' ? text : ''),
    },
  } as unknown as ClipboardEvent;
}

/** Drive the paste through the real plugin chain (someProp = exactly how EditorView dispatches paste). */
function paste(v: EditorView, event: ClipboardEvent): boolean {
  return v.someProp('handlePaste', (f) => f(v, event, Slice.empty)) === true;
}

describe('md paste — rendered editor DOM', () => {
  it('pastes a checklist as a heading + two todo nodes in the editor DOM', () => {
    const v = mount();
    expect(paste(v, clip('## Phase\n- [ ] a\n- [x] b'))).toBe(true);
    expect(v.dom.querySelector('h2')?.textContent).toBe('Phase');
    const todos = v.dom.querySelectorAll('[data-type="todo"]');
    expect(todos.length).toBe(2);
    expect(todos[0]?.getAttribute('data-checked')).toBe('false');
    expect(todos[1]?.getAttribute('data-checked')).toBe('true');
  });

  it('pastes a bold inline snippet inline (no new paragraph) with a <strong> mark', () => {
    const v = mount([{ id: P0, type: 'paragraph', content: { segments: [{ text: 'hi ' }] } }]);
    expect(paste(v, clip('**there**'))).toBe(true);
    expect(v.dom.querySelectorAll('p').length).toBe(1);
    expect(v.dom.querySelector('strong')?.textContent).toBe('there');
    expect(v.dom.querySelector('p')?.textContent).toBe('hi there');
  });

  it('CONVERTS a markdown checklist even when a text/html flavour rides alongside (the bug fix)', () => {
    // Real clipboards attach a text/html flavour to almost every copy; the converter must still fire.
    const v = mount();
    expect(paste(v, clip('## Phase\n- [ ] a\n- [x] b', { html: '<p>## Phase</p>' }))).toBe(true);
    expect(v.dom.querySelector('h2')?.textContent).toBe('Phase');
    const todos = v.dom.querySelectorAll('[data-type="todo"]');
    expect(todos.length).toBe(2);
    expect(todos[0]?.getAttribute('data-checked')).toBe('false');
    expect(todos[1]?.getAttribute('data-checked')).toBe('true');
  });

  it('CONVERTS inline-mark-only markdown even with a text/html flavour present', () => {
    const v = mount([{ id: P0, type: 'paragraph', content: { segments: [{ text: 'x ' }] } }]);
    expect(paste(v, clip('some **bold** text', { html: '<p>some bold text</p>' }))).toBe(true);
    expect(v.dom.querySelector('strong')?.textContent).toBe('bold');
  });
});

describe('md paste — guards return false (default paste, no regression)', () => {
  it('does NOT handle a rich-web paste whose text is bare prose (text/html keeps its formatting)', () => {
    // A real webpage copy: rich text/html + a plain-prose text/plain with no markdown markers → defer so the
    // transformPastedHTML + parseDOM path renders the HTML formatting.
    const v = mount();
    expect(paste(v, clip('just some plain prose', { html: '<b>just some plain prose</b>' }))).toBe(false);
    // A handled paste would add a BODY heading; the title is itself an <h1 data-type="title">.
    expect(v.dom.querySelector('h1:not([data-type="title"])')).toBeNull();
  });

  it('does NOT handle a plain-prose paste with no html and no markdown', () => {
    const v = mount();
    expect(paste(v, clip('just some plain prose here'))).toBe(false);
    expect(v.dom.querySelector('h1:not([data-type="title"]), h2')).toBeNull();
  });

  it('does NOT handle a file paste (attachment plugin territory)', () => {
    const v = mount();
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    expect(paste(v, clip('', { files: [file] }))).toBe(false);
  });

  it('does NOT handle a lone URL paste (embeds card territory)', () => {
    const v = mount();
    expect(paste(v, clip('https://example.com'))).toBe(false);
    expect(v.dom.querySelector('h1:not([data-type="title"]), h2')).toBeNull();
  });

  it('does NOT inject blocks when the caret is in the title', () => {
    const v = mount(EMPTY, /* inTitle */ true);
    expect(paste(v, clip('## Phase\n- [ ] a'))).toBe(false);
    expect(v.dom.querySelector('h2')).toBeNull();
  });
});
