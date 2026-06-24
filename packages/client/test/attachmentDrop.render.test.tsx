/**
 * #132 A4-client — the attachment INSERT path (drop / paste a file → upload → embed). Mirrors the link_card
 * loading-then-fill pattern; the heavy node-view runtime loads lazily on the first file. uploadBlob is
 * mocked (no network); the real lazy runtime load is exercised.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { deltoSchema } from '../src/editor/schema.js';

const { uploadBlob } = vi.hoisted(() => ({ uploadBlob: vi.fn(async () => ({ hash: 'a'.repeat(64), size: 3 })) }));
vi.mock('../src/plugins/attachment/blobClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/plugins/attachment/blobClient.js')>();
  return { ...actual, uploadBlob };
});

import { attachmentDropPlugin } from '../src/plugins/attachment/attachmentDrop.js';

afterEach(() => vi.clearAllMocks());

function makeView() {
  const S = deltoSchema;
  const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), S.node('paragraph', { id: 'p' })]);
  let state = EditorState.create({ doc, plugins: [attachmentDropPlugin(S)] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 4))); // caret in the body paragraph
  return new EditorView(document.createElement('div'), { state });
}

function findAttachment(view: EditorView): Record<string, unknown> | null {
  let content: Record<string, unknown> | null = null;
  view.state.doc.descendants((n) => {
    if (n.type.name === 'plugin_block' && n.attrs.pluginType === 'attachment') content = n.attrs.pluginContent as Record<string, unknown>;
  });
  return content;
}

describe('#132 attachment drop/paste insert', () => {
  it('paste a file → inserts a loading attachment block, then fills it with the uploaded hash', async () => {
    const view = makeView();
    const file = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' });

    const handled = attachmentDropPlugin(deltoSchema).props!.handlePaste!(
      view,
      { clipboardData: { files: [file] } } as unknown as ClipboardEvent,
      // @ts-expect-error PM passes a slice we don't use
      undefined,
    );
    expect(handled).toBe(true);

    await vi.waitFor(() => {
      const c = findAttachment(view);
      expect(c).toMatchObject({ hash: 'a'.repeat(64), name: 'pic.png', mime: 'image/png', size: 3 });
    });
    expect(uploadBlob).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it('paste with NO files → not handled (text/URL paste falls through)', () => {
    const view = makeView();
    const handled = attachmentDropPlugin(deltoSchema).props!.handlePaste!(
      view,
      { clipboardData: { files: [] } } as unknown as ClipboardEvent,
      // @ts-expect-error unused slice
      undefined,
    );
    expect(handled).toBe(false);
    expect(findAttachment(view)).toBeNull();
    view.destroy();
  });
});
