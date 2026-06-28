/**
 * Block-object chrome — MOUNTED-EDITOR gate ([[ui-features-need-rendered-ui-gate]]). Unit-green on the
 * commands/schema isn't "usable"; this mounts the real editor tree (a live EditorView + the plugin NodeViews)
 * and asserts the rendered DOM + selection behaviour the feature is actually about:
 *   - the caret FLANKS the block object (a real text position on each side, one apart),
 *   - a single-press delete TEARS THE NODEVIEW DOWN (the island leaves the DOM on the first press),
 *   - the DRAG HANDLE is rendered, draggable, and its stopEvent policy lets a grip drag-start reach PM.
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PmNode } from 'prosemirror-model';
import { deltoSchema as S } from '../src/editor/schema.js';
import { buildPluginIslandNodeViews } from '../src/editor/nodeviews/PluginIsland.js';
import { collectEagerContributions, pluginRegistry } from '../src/plugins/runtime/index.js';
import { deleteInlineAtomBackspace } from '../src/editor/plugins/blockAtomChrome.js';
import { blockHandleStopEvent } from '../src/editor/plugins/blockDragHandle.js';
import { AttachmentNodeView } from '../src/plugins/attachment/AttachmentNodeView.js';

// link_card's island factory (its NodeView) is registered through the manifest spine — collecting the eager
// built-in contributions performs that registration (same as embeds.render.test.tsx).
collectEagerContributions(pluginRegistry);

const views: EditorView[] = [];
afterEach(() => { while (views.length) views.pop()!.destroy(); vi.clearAllMocks(); });

function mountCardEditor() {
  const doc = S.node('doc', null, [
    S.node('title', { id: 't' }, [S.text('T')]),
    S.node('paragraph', { id: 'wrap' }, [
      S.node('plugin_block', { id: 'c', pluginType: 'link_card', pluginContent: { url: 'https://example.com', title: 'Example' } }),
    ]),
  ]);
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({ doc, schema: S }),
    nodeViews: { ...buildPluginIslandNodeViews(S) },
  });
  views.push(view);
  let at = -1;
  view.state.doc.descendants((n, pos) => { if (n.type.name === 'plugin_block') at = pos; });
  return { view, at };
}

describe('block-object chrome (mounted) — caret flanks the object', () => {
  it('there is a real text position immediately BEFORE and AFTER the object, one apart', () => {
    const { view, at } = mountCardEditor();
    const before = TextSelection.create(view.state.doc, at);
    const after = TextSelection.create(view.state.doc, at + 1);
    expect(before.$from.parent.type.name).toBe('paragraph'); // a caret sits in the wrapping textblock, not the atom
    expect(after.$from.parent.type.name).toBe('paragraph');
    expect(after.$from.pos - before.$from.pos).toBe(1); // ArrowLeft/Right step across it as ONE position
  });
});

describe('block-object chrome (mounted) — single-press delete tears the NodeView out of the DOM', () => {
  it('Backspace right after the object removes the island from the live DOM on the first press', async () => {
    const { view, at } = mountCardEditor();
    await vi.waitFor(() => expect(view.dom.querySelector('.link-card-island')).not.toBeNull());
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at + 1))); // caret right after
    const handled = deleteInlineAtomBackspace(view.state, view.dispatch);
    expect(handled).toBe(true);
    let present = false; view.state.doc.descendants((n) => { if (n.type.name === 'plugin_block') present = true; });
    expect(present).toBe(false);
    expect(view.dom.querySelector('.link-card-island')).toBeNull(); // the mounted island is gone from the DOM
  });
});

describe('block-object chrome (mounted) — the drag handle is rendered + wired', () => {
  it('the link-card island renders a draggable grip alongside the card body', async () => {
    const { view } = mountCardEditor();
    await vi.waitFor(() => expect(view.dom.querySelector('.link-card')).not.toBeNull());
    const handle = view.dom.querySelector('.link-card-island .block-drag-handle') as HTMLElement;
    expect(handle).not.toBeNull();
    expect(handle.draggable).toBe(true);
    expect(handle.getAttribute('data-drag-handle')).toBe('true');
    expect(view.dom.querySelector('.link-card-island .block-object-body .link-card')).not.toBeNull(); // card mounts in the body, not the grip
  });

  it('the attachment island also renders a draggable grip (shared chrome)', () => {
    const nv = new AttachmentNodeView(S.node('plugin_block', { id: 'a', pluginType: 'attachment', pluginContent: { name: 'f.png' } }));
    const handle = nv.dom.querySelector('.block-drag-handle') as HTMLElement;
    expect(nv.dom.className).toBe('attachment-island');
    expect(handle).not.toBeNull();
    expect(handle.draggable).toBe(true);
    expect(nv.dom.querySelector('.block-object-body')).not.toBeNull();
    nv.destroy();
  });
});

describe('block-object chrome — stopEvent policy lets a grip drag-start reach PM, isolates the rest', () => {
  const handle = document.createElement('div');
  const body = document.createElement('div');
  it('a dragstart originating ON the grip passes through to PM (false → PM drags the atom)', () => {
    const e = { type: 'dragstart', target: handle } as unknown as Event;
    expect(blockHandleStopEvent(handle, e)).toBe(false);
  });
  it('a click on the grip stays in the view (true) — only drag-init events pass', () => {
    const e = { type: 'click', target: handle } as unknown as Event;
    expect(blockHandleStopEvent(handle, e)).toBe(true);
  });
  it('any event OFF the grip (the React interior) stays in the view (true)', () => {
    const e = { type: 'dragstart', target: body } as unknown as Event;
    expect(blockHandleStopEvent(handle, e)).toBe(true);
  });
});
