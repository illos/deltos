/**
 * Render-only resolver (docs/specs/plugin-support.md §5 fork b, A2 #124) — the READ PATH for plugin blocks,
 * used outside an editor (search peek, list preview, history diff, share). PM-FREE BY CONSTRUCTION: this
 * module and everything it imports (the render-only components) must never pull prosemirror-view, so a
 * read-only surface stays light ([[performance-is-a-standing-value]]). That's why the read registry lives
 * here, separate from the edit registry (runtime/index.ts → builtins.ts, which imports the PM NodeViews/
 * plugins). They are two views of the same plugins; a future unification (one manifest with split lazy
 * edit/render modules) is additive.
 */
import type { ReactNode } from 'react';
import { LinkCardRenderOnly } from '../embeds/LinkCardRenderOnly.js';
import { AttachmentRenderOnly } from '../attachment/AttachmentRenderOnly.js';
import type { PluginRenderContext, PluginRenderOnlyComponent } from './renderContext.js';

export type { PluginRenderContext, PluginRenderOnlyComponent } from './renderContext.js';

/** Built-in render-only components, keyed by plugin_block `pluginType`. PM-free, fetch-free imports only. */
const BUILT_IN_RENDER_ONLY: Readonly<Record<string, PluginRenderOnlyComponent>> = {
  link_card: LinkCardRenderOnly,
  attachment: AttachmentRenderOnly,
};

/** The render-only component for a block type, or undefined if none ships one (→ raw placeholder). */
export function resolveRenderOnly(type: string): PluginRenderOnlyComponent | undefined {
  return BUILT_IN_RENDER_ONLY[type];
}

/**
 * Render a plugin_block read-only. Resolves the block's render-only component and passes the payload +
 * context; an unrecognized type falls back to a LOSSLESS raw placeholder (the payload is never touched, so
 * an unknown block in a read-only context renders a marker rather than vanishing — §6).
 */
export function PluginBlockRenderOnly({
  type,
  payload,
  context,
}: {
  type: string;
  payload: unknown;
  context: PluginRenderContext;
}): ReactNode {
  const Component = resolveRenderOnly(type);
  if (Component) return <Component payload={payload} context={context} />;
  return (
    <span className="editor-plugin-island editor-plugin-island--unknown" data-plugin-type={type}>
      {`Unknown block [${type}]`}
    </span>
  );
}
