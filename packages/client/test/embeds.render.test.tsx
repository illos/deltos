/**
 * #69 E2b rich-embeds — the paste-to-card handler + the LinkCard NodeView (mount + downgrade). unfurl is
 * mocked (no network); the live route is integration/on-device.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Slice } from 'prosemirror-model';
import { deltoSchema } from '../src/editor/schema.js';

vi.mock('../src/plugins/embeds/unfurl.js', () => ({
  unfurl: vi.fn(async (url: string) => ({ url, title: 'Example Site', favicon: 'https://example.com/f.ico' })),
  UnfurlError: class extends Error {},
}));

import { linkCardPastePlugin } from '../src/plugins/embeds/index.js';
import { buildPluginIslandNodeViews } from '../src/editor/nodeviews/PluginIsland.js';
import { unfurl } from '../src/plugins/embeds/unfurl.js';
import { collectEagerContributions, pluginRegistry } from '../src/plugins/runtime/index.js';

const S = deltoSchema;
// A1 (#123): the link_card island factory is registered through the manifest spine now (no import
// side-effect). Collecting the eager built-in contributions performs that registration.
collectEagerContributions(pluginRegistry);
afterEach(() => vi.clearAllMocks());

function makeView() {
  const doc = S.node('doc', null, [S.node('title', { id: 't' }, [S.text('T')]), S.node('paragraph', { id: 'p' })]);
  let state = EditorState.create({ doc, schema: S, plugins: [linkCardPastePlugin(S)] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 4))); // cursor in the body paragraph
  const view = new EditorView(document.createElement('div'), {
    state,
    nodeViews: { ...buildPluginIslandNodeViews(S) }, // link_card factory registered via the manifest spine (collectEagerContributions, top of file)
  });
  return view;
}
const paste = (view: EditorView, text: string) =>
  linkCardPastePlugin(S).props.handlePaste!(view, { clipboardData: { getData: () => text } } as unknown as ClipboardEvent, Slice.empty);

const findCard = (view: EditorView) => {
  let card = null as null | { url?: string; loading?: boolean; title?: string; error?: boolean };
  view.state.doc.descendants((n) => {
    if (n.type.name === 'plugin_block' && n.attrs.pluginType === 'link_card') card = n.attrs.pluginContent;
  });
  return card;
};

describe('linkCardPastePlugin — paste-to-card', () => {
  it('a BARE URL paste inserts a loading link_card + calls unfurl with the url', async () => {
    const view = makeView();
    const handled = paste(view, 'https://example.com');
    expect(handled).toBe(true);
    const card = findCard(view);
    expect(card).toMatchObject({ url: 'https://example.com', loading: true });
    expect(unfurl).toHaveBeenCalledWith('https://example.com');
    // unfurl resolves → the loading card fills with metadata
    await vi.waitFor(() => expect(findCard(view)).toMatchObject({ title: 'Example Site', loading: false }));
    view.destroy();
  });

  it('non-URL text (or a URL with surrounding text) is NOT cardified — normal paste', () => {
    const view = makeView();
    expect(paste(view, 'just some text')).toBe(false);
    expect(paste(view, 'see https://example.com here')).toBe(false); // not a BARE url alone
    expect(findCard(view)).toBeNull();
    expect(unfurl).not.toHaveBeenCalled();
    view.destroy();
  });
});

describe('LinkCardNodeView — mount + downgrade', () => {
  it('mounts the LinkCard and downgrade replaces the card with a paragraph carrying a link mark', async () => {
    const doc = S.node('doc', null, [
      S.node('title', { id: 't' }, [S.text('T')]),
      S.node('plugin_block', { id: 'c', pluginType: 'link_card', pluginContent: { url: 'https://example.com', title: 'Example' } }),
    ]);
    const view = new EditorView(document.createElement('div'), {
      state: EditorState.create({ doc, schema: S }),
      nodeViews: { ...buildPluginIslandNodeViews(S) },
    });
    // the card React component mounts into the island
    await vi.waitFor(() => expect(view.dom.querySelector('.link-card')).not.toBeNull());

    // downgrade (the card's x) → the plugin_block becomes a paragraph with a link mark
    const x = view.dom.querySelector('.link-card__downgrade') as HTMLElement;
    expect(x).not.toBeNull();
    x.click();
    const body = view.state.doc.child(1);
    expect(body.type.name).toBe('paragraph');
    expect(body.textContent).toBe('https://example.com');
    expect(view.state.doc.rangeHasMark(view.state.doc.content.size - body.content.size - 1, view.state.doc.content.size - 1, S.marks['link']!)).toBe(true);
    view.destroy();
  });
});
