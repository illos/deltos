import type { Node as PmNode, NodeType } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';

/**
 * Plugin island seam — NodeView contract.
 *
 * A plugin block is OPAQUE to the core editor. The host (this EditorView) owns:
 *   - cursor / selection around the block
 *   - drag / drop / reorder between blocks
 *   - export + search (via the block's spine `content` field)
 *
 * The plugin owns everything INSIDE the block:
 *   - rendering (`dom`)
 *   - editing events (`update`, `stopEvent`)
 *   - Markdown export (via its `searchText()` registration)
 *
 * This seam is designed now and built later. When a plugin is registered:
 *   1. Its manifest declares a block type key (e.g. `"recipe-card"`).
 *   2. The host calls `registerPluginBlockView(view, type, factory)`.
 *   3. The factory returns a `PluginIslandView` for every `plugin_block` node of that type.
 *
 * Collab note: plugin_block is `atom: true` in the schema. In the promote-to-DO collab seam,
 * atoms are treated as opaque units — a conflict on an atom replaces it whole. A plugin that
 * opts into collaboration (manifest `collaborative: true`) upgrades from atom to a full DO
 * with its own PM-Steps channel for the block's interior. That is a v2 concern; the seam shape
 * (atom → NodeView → optional DO interior) requires no schema change.
 */

export interface PluginIslandFactory {
  /** Return a NodeView for this plugin_block node. */
  create(node: PmNode, view: EditorView, getPos: () => number | undefined): NodeView;
}

const registry = new Map<string, PluginIslandFactory>();

/** Register a NodeView factory for a given plugin block type. Phase 2+. */
export function registerPluginIsland(pluginType: string, factory: PluginIslandFactory): void {
  registry.set(pluginType, factory);
}

/** Retrieve the NodeView factory for a given plugin block type, if registered. */
export function getPluginIslandFactory(pluginType: string): PluginIslandFactory | undefined {
  return registry.get(pluginType);
}

/**
 * Fallback NodeView for plugin_block nodes whose plugin is not (yet) registered.
 * Renders a styled placeholder so the block is visible and selectable.
 */
export class UnknownPluginIslandView implements NodeView {
  readonly dom: HTMLElement;

  constructor(node: PmNode) {
    const el = document.createElement('div');
    el.className = 'editor-plugin-island editor-plugin-island--unknown';
    el.setAttribute('data-plugin-type', node.attrs.pluginType as string);
    el.contentEditable = 'false';
    el.textContent = `[${node.attrs.pluginType as string}]`;
    this.dom = el;
  }

  // stopEvent: return true so PM does not handle keyboard events inside the island.
  stopEvent(): boolean { return true; }

  // ignoreMutation: return true so the mutation observer doesn't track internal DOM changes.
  ignoreMutation(): boolean { return true; }
}

/**
 * The nodeViews map to pass to EditorView constructor. Expands as plugins register.
 * Produces an UnknownPluginIslandView for unregistered types.
 */
export function buildPluginIslandNodeViews(
  schema: { nodes: Record<string, NodeType> },
): Record<string, (node: PmNode, view: EditorView, getPos: () => number | undefined) => NodeView> {
  if (!schema.nodes['plugin_block']) return {};
  return {
    plugin_block(node, view, getPos) {
      const pluginType = node.attrs.pluginType as string;
      const factory = getPluginIslandFactory(pluginType);
      return factory ? factory.create(node, view, getPos) : new UnknownPluginIslandView(node);
    },
  };
}
