import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { DeltoSchema } from '../../editor/schema.js';
import { unfurl } from './unfurl.js';

/**
 * Rich-embeds plugin (#69 E2b) — the `link_card` plugin_block NodeView + the paste-to-card handler. As of
 * A1 (#123) registration goes through the manifest spine: the `link-card` built-in manifest
 * (runtime/builtins.ts) declares the island factory (its NodeView) + this paste plugin. No import
 * side-effect — the loader performs the registration. The editor core never imports this directly.
 */

// A bare URL alone (the whole pasted text, trimmed) → a card; anything else pastes normally (inline URLs
// auto-linkify via the core input rule). Conservative pattern: a single http(s) token, no whitespace.
const BARE_URL_RE = /^https?:\/\/[^\s]+$/i;

/** Find the loading link_card for `url` (position may have shifted since insert) and set its content. */
function fillCard(view: EditorView, url: string, content: Record<string, unknown>): void {
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.type.name === 'plugin_block' && node.attrs.pluginType === 'link_card') {
      const c = node.attrs.pluginContent as { url?: string; loading?: boolean } | null;
      if (c && c.url === url && c.loading) { at = pos; return false; }
    }
    return true;
  });
  if (at < 0) return;
  const node = view.state.doc.nodeAt(at);
  if (!node) return;
  view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, pluginContent: content }));
}

export function linkCardPastePlugin(schema: DeltoSchema): Plugin {
  const pluginBlock = schema.nodes['plugin_block'];
  return new Plugin({
    props: {
      handlePaste(view, event) {
        if (!pluginBlock) return false;
        const text = event.clipboardData?.getData('text/plain')?.trim();
        if (!text || !BARE_URL_RE.test(text)) return false; // not a bare URL → let PM paste normally

        const card = pluginBlock.create({ pluginType: 'link_card', pluginContent: { url: text, loading: true } });
        view.dispatch(view.state.tr.replaceSelectionWith(card).scrollIntoView());

        // Resolve metadata off the paste. The unfurl ROUTE may be held (secSys #71) → on failure the card
        // shows its error state (still clickable + downgradeable). Untrusted text/urls — the component
        // renders title as text + validates the favicon scheme.
        void unfurl(text)
          .then((meta) => fillCard(view, text, { ...meta, loading: false }))
          .catch(() => fillCard(view, text, { url: text, loading: false, error: true }));
        return true;
      },
    },
  });
}
