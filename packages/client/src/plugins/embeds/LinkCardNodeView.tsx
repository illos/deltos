import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { Node as PmNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { LinkCard } from './LinkCard.js';
import type { LinkCardProps } from './LinkCard.js';
import { openLinkInNewTab } from '../../editor/openLink.js';
import { deltoSchema } from '../../editor/schema.js';

/**
 * LinkCardNodeView (#69 rich-embeds E2b) — the imperative PM NodeView for a `link_card` plugin_block. It
 * mounts gruntSys's presentational LinkCard React component (E2a) into the atom's DOM via a React root.
 * The plugin_block is an ATOM, so stopEvent + ignoreMutation keep PM out of the React-managed interior.
 *
 * pluginContent carries the card's data: { url, title?, favicon?, siteName?, loading?, error? }. onOpen
 * reuses the scheme-safe openLinkInNewTab (rung-0). onDowngrade (the card's x) replaces the card with a
 * paragraph of the URL text + a link mark — the same mark setLink produces.
 *
 * Module boundary: plugins import FROM the editor; the editor core never imports plugins (it reaches this
 * via the single registerPluginIsland seam — see ./index.ts).
 */

interface CardContent {
  url?: string;
  title?: string;
  favicon?: string;
  siteName?: string;
  loading?: boolean;
  error?: boolean;
}

export class LinkCardNodeView implements NodeView {
  dom: HTMLElement;
  private root: Root;
  private node: PmNode;

  constructor(node: PmNode, private readonly view: EditorView, private readonly getPos: () => number | undefined) {
    this.node = node;
    this.dom = document.createElement('div');
    this.dom.className = 'link-card-island';
    this.dom.setAttribute('data-plugin-type', 'link_card');
    this.root = createRoot(this.dom);
    this.renderCard();
  }

  private renderCard(): void {
    const c = (this.node.attrs.pluginContent ?? {}) as CardContent;
    const url = c.url ?? '';
    // Build props with the optional metadata set only when present (exactOptionalPropertyTypes: an
    // optional prop won't accept an explicit `undefined`).
    const props: LinkCardProps = {
      url,
      loading: !!c.loading,
      error: !!c.error,
      onOpen: () => openLinkInNewTab(url),
      onDowngrade: () => this.downgrade(url),
    };
    if (c.title !== undefined) props.title = c.title;
    if (c.favicon !== undefined) props.favicon = c.favicon;
    if (c.siteName !== undefined) props.siteName = c.siteName;
    this.root.render(<LinkCard {...props} />);
  }

  /** Replace the card node with a paragraph of the URL text carrying a link mark (rung-0 plain link). */
  private downgrade(url: string): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const { state } = this.view;
    const here = state.doc.nodeAt(pos);
    if (!here) return;
    const linkType = deltoSchema.marks['link'];
    const para = deltoSchema.nodes['paragraph']?.create(
      null,
      url ? deltoSchema.text(url, linkType ? [linkType.create({ href: url, title: null })] : []) : null,
    );
    if (!para) return;
    this.view.dispatch(state.tr.replaceWith(pos, pos + here.nodeSize, para).scrollIntoView());
    this.view.focus();
  }

  update(node: PmNode): boolean {
    if (node.type.name !== 'plugin_block' || node.attrs.pluginType !== 'link_card') return false;
    this.node = node;
    this.renderCard();
    return true;
  }

  stopEvent(): boolean { return true; }
  ignoreMutation(): boolean { return true; }
  destroy(): void {
    // Defer so we never unmount synchronously inside a React render cycle (React 19 guard).
    const root = this.root;
    queueMicrotask(() => root.unmount());
  }
}
