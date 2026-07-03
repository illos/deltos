/**
 * Mount-level md-paste test (ui-features-need-rendered-ui-gate): a REAL EditorView running the REAL paste
 * path — `view.pasteText` / `view.pasteHTML` are prosemirror-view's own doPaste (the exact code a
 * ClipboardEvent reaches), so the dispatch carries `uiEvent:'paste'` and the pipeline's bulk leg
 * ([ROAD-0007] step 4) does the conversion. Proves plain-text markdown renders as real nodes in the editor
 * DOM, that a rich HTML paste keeps its formatting (never re-parsed), that markdown pasted into a code
 * block or the title stays literal, and that ONE undo reverts a converted paste.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo } from 'prosemirror-history';
import type { BlockBody, BlockId } from '@deltos/shared';
import { deltoSchema } from '../src/editor/schema.js';
import { spineToPmDoc } from '../src/editor/serializer.js';
import { buildEditorTransformRegistry } from '../src/editor/editorTransforms.js';
import { createDefaultFormulaRegistry } from '../src/plugins/formula/index.js';
import { buildInputPipelinePlugin } from '../src/editor/inputPipeline/index.js';
import { uniqueBlockIdPlugin } from '../src/editor/plugins/blockId.js';

const P0: BlockId = '00000000-1111-4111-8111-111111111111' as BlockId;
const EMPTY: BlockBody = [{ id: P0, type: 'paragraph', content: { segments: [] } }];

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; });

/** Mount a real EditorView with the pipeline (production registry) + history + blockId. */
function mount(body: BlockBody = EMPTY, inTitle = false): EditorView {
  const doc = spineToPmDoc(deltoSchema, body, 'Title');
  const selection = inTitle ? TextSelection.atStart(doc) : TextSelection.atEnd(doc);
  const registry = buildEditorTransformRegistry(deltoSchema, createDefaultFormulaRegistry());
  const state = EditorState.create({
    doc,
    selection,
    plugins: [buildInputPipelinePlugin(registry), history(), uniqueBlockIdPlugin],
  });
  const mountPoint = document.createElement('div');
  document.body.appendChild(mountPoint);
  view = new EditorView(mountPoint, { state });
  return view;
}

// jsdom may lack the ClipboardEvent constructor pasteText/pasteHTML default to — pass a stand-in event.
const pasteEvent = () => new Event('paste') as ClipboardEvent;

describe('md paste — rendered editor DOM (the real doPaste path)', () => {
  it('pastes a checklist as a heading + two todo nodes in the editor DOM', () => {
    const v = mount();
    v.pasteText('## Phase\n- [ ] a\n- [x] b', pasteEvent());
    expect(v.dom.querySelector('h2')?.textContent).toBe('Phase');
    const todos = v.dom.querySelectorAll('[data-type="todo"]');
    expect(todos.length).toBe(2);
    expect(todos[0]?.getAttribute('data-checked')).toBe('false');
    expect(todos[1]?.getAttribute('data-checked')).toBe('true');
  });

  it('pastes a bold inline snippet inline (no new paragraph) with a <strong> mark', () => {
    const v = mount([{ id: P0, type: 'paragraph', content: { segments: [{ text: 'hi ' }] } }]);
    v.pasteText('**there**', pasteEvent());
    expect(v.dom.querySelectorAll('p').length).toBe(1);
    expect(v.dom.querySelector('strong')?.textContent).toBe('there');
    expect(v.dom.querySelector('p')?.textContent).toBe('hi there');
  });

  it('CONVERTS literal markdown arriving via the HTML flavour (plain <p> literals — the flavour-independence fix)', () => {
    // Real clipboards attach a text/html flavour to almost every copy; when it is just literal text in
    // plain paragraphs (a chat client, a terminal, deltos itself), the parsed insertion is unmarked
    // paragraphs of markdown — the bulk leg converts it exactly like a plain-text paste.
    const v = mount();
    v.pasteHTML('<p>## Phase</p><p>- [ ] a</p><p>- [x] b</p>', pasteEvent());
    expect(v.dom.querySelector('h2')?.textContent).toBe('Phase');
    const todos = v.dom.querySelectorAll('[data-type="todo"]');
    expect(todos.length).toBe(2);
    expect(todos[0]?.getAttribute('data-checked')).toBe('false');
    expect(todos[1]?.getAttribute('data-checked')).toBe('true');
  });

  it('ONE undo reverts a converted paste back to the pre-paste doc (§5.1 history grouping)', () => {
    const v = mount();
    v.pasteText('## Phase\n- [ ] a', pasteEvent());
    expect(v.dom.querySelector('h2')).toBeTruthy();
    undo(v.state, v.dispatch);
    expect(v.dom.querySelector('h2')).toBeNull();
    expect(v.dom.querySelectorAll('[data-type="todo"]').length).toBe(0);
    expect(v.state.doc.textContent).not.toContain('## Phase');
  });
});

describe('md paste — guards (default paste stands, no re-parse)', () => {
  it('keeps a rich-web paste as formatting (bold HTML is not re-parsed as markdown)', () => {
    const v = mount();
    v.pasteHTML('<p>looks like <b>**markdown**</b> but is rich</p>', pasteEvent());
    // The bold mark survives AND the literal '**markdown**' inside it is untouched.
    expect(v.dom.querySelector('strong')?.textContent).toContain('**markdown**');
    expect(v.dom.querySelector('h1:not([data-type="title"]), h2')).toBeNull();
  });

  it('leaves plain prose exactly as the default paste inserted it', () => {
    const v = mount();
    v.pasteText('just some plain prose here', pasteEvent());
    expect(v.state.doc.textContent).toContain('just some plain prose here');
    expect(v.dom.querySelector('h1:not([data-type="title"]), h2')).toBeNull();
  });

  it('leaves a lone URL paste literal (embeds card territory; no link mark, no blocks)', () => {
    const v = mount();
    v.pasteText('https://example.com', pasteEvent());
    expect(v.state.doc.textContent).toContain('https://example.com');
    expect(v.dom.querySelector('a')).toBeNull();
    expect(v.dom.querySelector('h1:not([data-type="title"]), h2')).toBeNull();
  });

  it('keeps markdown pasted INTO a code block literal (code-zone guard)', () => {
    const v = mount([{ id: P0, type: 'code', content: { code: 'existing' } }]);
    v.pasteText('# not a heading', pasteEvent());
    expect(v.state.doc.textContent).toContain('# not a heading');
    expect(v.dom.querySelector('h1:not([data-type="title"]), h2')).toBeNull();
  });

  it('a paste starting in the title keeps the title plain but converts the body spill', () => {
    // Line 1 merges into the title (never converted — the title is not a run); line 2 spills into the
    // body and converts. The old start-position guard skipped the whole paste (the whole-note-copy bug).
    const v = mount(EMPTY, /* inTitle */ true);
    v.pasteText('## Phase\n- [ ] a', pasteEvent());
    expect(v.dom.querySelector('h1[data-type="title"]')?.textContent).toContain('## Phase');
    expect(v.dom.querySelector('h2')).toBeNull();
    expect(v.dom.querySelectorAll('[data-type="todo"]').length).toBe(1);
  });
});
