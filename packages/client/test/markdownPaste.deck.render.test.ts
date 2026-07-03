/**
 * "The Deck" markdown-paste path (iOS custom-keyboard / inputmode=none). When the custom on-screen keyboard
 * is active the ProseMirror editable is created with `inputmode=none`, and the iOS edit-menu "Paste" is
 * delivered NOT as a `paste` ClipboardEvent but as a `beforeinput` with `inputType==='insertFromPaste'`.
 * prosemirror-view (1.41.x) synthesizes `handlePaste` ONLY from the `paste` event — its beforeinput handler
 * ignores insertFromPaste — so the markdown used to land as literal text (or not at all).
 *
 * Step 4's delivery adapter (inputPipeline/plugin.ts handleDOMEvents.beforeinput) is EXTRACTION-ONLY: it
 * cancels the default insertion and re-delivers the text through `view.pasteText` — prosemirror-view's own
 * paste path — so the Deck and desktop CONVERGE: same handlePaste chance for embeds/attachments, same
 * `uiEvent:'paste'` dispatch, same bulk-leg conversion. These tests drive the adapter against a REAL
 * EditorView (sync dataTransfer fast path + async clipboard fallback).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Plugin } from 'prosemirror-state';
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
let pipeline: Plugin;
afterEach(() => {
  view?.destroy();
  view = null;
  vi.unstubAllGlobals();
});

function mount(body: BlockBody = EMPTY): EditorView {
  const doc = spineToPmDoc(deltoSchema, body, 'Title');
  const registry = buildEditorTransformRegistry(deltoSchema, createDefaultFormulaRegistry());
  pipeline = buildInputPipelinePlugin(registry);
  const state = EditorState.create({
    doc,
    selection: TextSelection.atEnd(doc),
    plugins: [pipeline, uniqueBlockIdPlugin],
  });
  const mountPoint = document.createElement('div');
  document.body.appendChild(mountPoint);
  view = new EditorView(mountPoint, { state });
  return view;
}

/** Minimal InputEvent stand-in for `beforeinput`. `dtText === null` ⇒ no dataTransfer (async-clipboard path). */
function beforeinputEvent(inputType: string, dtText: string | null) {
  const ev = {
    inputType,
    dataTransfer: dtText === null ? null : { getData: (t: string) => (t === 'text/plain' ? dtText : '') },
    prevented: false,
    preventDefault() { (ev as { prevented: boolean }).prevented = true; },
  };
  return ev;
}

/** The adapter under test, off the SAME plugin instance the mounted view runs. */
function fireBeforeinput(v: EditorView, ev: ReturnType<typeof beforeinputEvent>): boolean {
  const beforeinput = (pipeline.props.handleDOMEvents as {
    beforeinput: (view: EditorView, e: Event) => boolean;
  }).beforeinput;
  return beforeinput(v, ev as unknown as Event);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('deck paste — sync dataTransfer fast path', () => {
  it('CONVERTS markdown delivered as insertFromPaste (heading + todos land as real nodes)', () => {
    const v = mount();
    const ev = beforeinputEvent('insertFromPaste', '## Phase\n- [ ] a\n- [x] b');
    expect(fireBeforeinput(v, ev)).toBe(true);
    expect(ev.prevented).toBe(true);
    expect(v.dom.querySelector('h2')?.textContent).toBe('Phase');
    const todos = v.dom.querySelectorAll('[data-type="todo"]');
    expect(todos.length).toBe(2);
    expect(todos[0]?.getAttribute('data-checked')).toBe('false');
    expect(todos[1]?.getAttribute('data-checked')).toBe('true');
  });

  it('inserts plain prose as plain text (converges with the default paste — no conversion, no loss)', () => {
    const v = mount();
    const ev = beforeinputEvent('insertFromPaste', 'just some plain prose');
    expect(fireBeforeinput(v, ev)).toBe(true);
    expect(ev.prevented).toBe(true);
    expect(v.state.doc.textContent).toContain('just some plain prose');
    expect(v.dom.querySelector('h2')).toBeNull();
  });

  it('leaves a lone URL literal for its own handler class (no md conversion)', () => {
    const v = mount();
    const ev = beforeinputEvent('insertFromPaste', 'https://example.com');
    expect(fireBeforeinput(v, ev)).toBe(true);
    expect(v.state.doc.textContent).toContain('https://example.com');
    expect(v.dom.querySelector('h2')).toBeNull();
  });
});

describe('deck paste — async clipboard fallback (iOS omits dataTransfer under inputmode=none)', () => {
  it('reads the clipboard asynchronously and converts markdown', async () => {
    const v = mount();
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { readText: async () => '## Phase\n- [ ] a' },
    });
    const ev = beforeinputEvent('insertFromPaste', null);
    expect(fireBeforeinput(v, ev)).toBe(true);
    expect(ev.prevented).toBe(true);
    await flush();
    expect(v.dom.querySelector('h2')?.textContent).toBe('Phase');
    expect(v.dom.querySelectorAll('[data-type="todo"]').length).toBe(1);
  });

  it('inserts plain prose from the async clipboard as-is (the suppressed default is replicated)', async () => {
    const v = mount();
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { readText: async () => 'plain prose from clipboard' },
    });
    const ev = beforeinputEvent('insertFromPaste', null);
    expect(fireBeforeinput(v, ev)).toBe(true);
    await flush();
    expect(v.state.doc.textContent).toContain('plain prose from clipboard');
  });

  it('a failing clipboard read inserts nothing and does not throw', async () => {
    const v = mount();
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { readText: async () => { throw new Error('denied'); } },
    });
    const before = v.state.doc.toJSON();
    const ev = beforeinputEvent('insertFromPaste', null);
    expect(fireBeforeinput(v, ev)).toBe(true);
    await flush();
    expect(v.state.doc.toJSON()).toEqual(before);
  });
});

describe('deck paste — inputTypes the adapter must NOT hijack', () => {
  it('ignores ordinary typing inputTypes (insertText)', () => {
    const v = mount();
    const ev = beforeinputEvent('insertText', '# h');
    expect(fireBeforeinput(v, ev)).toBe(false);
    expect(ev.prevented).toBe(false);
  });

  it('ignores insertReplacementText (autocorrect targets a range — hijacking would misplace it)', () => {
    const v = mount();
    const ev = beforeinputEvent('insertReplacementText', '## Phase\n- [ ] a');
    expect(fireBeforeinput(v, ev)).toBe(false);
    expect(ev.prevented).toBe(false);
    expect(v.dom.querySelector('h2')).toBeNull();
  });
});
