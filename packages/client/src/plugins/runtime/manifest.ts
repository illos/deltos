/**
 * Plugin manifest — the missing SPINE (docs/specs/plugin-support.md §1, §3). A plugin is a bundle that
 * contributes to the extension points that ALREADY exist as registries (formula types, plugin-block
 * node-views, editor tools, …). The manifest is the single declaration of *which* it contributes to + its
 * identity + capabilities; the loader (registry.ts) reads it and performs the registrations.
 *
 * TWO TIERS (§3):
 *  - Tier-1 = this manifest's metadata (id / name / capabilities / blockTypes / palette / schemaVersion).
 *    Tiny, no runtime imports, lives in the editor chunk — the discovery layer (palette, friendly unknown
 *    placeholder). Registering every manifest at editor-init does NOT touch the entry bundle.
 *  - Tier-2 = `load()` → a PluginRuntime carrying the heavy contributions. v1 first-party plugins resolve
 *    it SYNCHRONOUSLY (they're tiny + already in the editor chunk — behavior-preserving). The async return
 *    type is for future HEAVY/new plugins (e.g. the attachment shard) that dynamic-`import()` on demand;
 *    until a block's runtime is loaded it renders via the friendly unknown placeholder (§6).
 *
 * AGGREGATE, don't collapse (§13 lean): the runtime DECLARES contributions in the vocabulary of the
 * existing registries; the loader APPLIES them to those registries. Formula stays a FormulaRegistry,
 * islands stay the PluginIsland map, tools stay the ToolDescriptor list.
 */
import type { Plugin } from 'prosemirror-state';
import type { DeltoSchema } from '../../editor/schema.js';
import type { FormulaType } from '../formula/index.js';
import type { PluginIslandFactory } from '../../editor/nodeviews/PluginIsland.js';
import type { ToolDescriptor } from '../../editor/editorTools.js';

/**
 * Declared capabilities (§4). `offline` is the local-first DEFAULT; anything stronger is the declared
 * exception that must degrade gracefully (enforced by render-context, A3). v1 only records them on the
 * manifest — degraded-render plumbing arrives in A3.
 */
export type PluginCapability = 'offline' | 'online-only' | 'collaborative' | 'storage' | 'network';

/** Tier-1 palette/discovery entry (consumed by the slash palette, A5). Metadata only — no runtime. */
export interface PluginPaletteEntry {
  /** Human label shown in the palette / new-note menu. */
  readonly label: string;
  /** Autosuggest keywords. */
  readonly keywords?: readonly string[];
  /** Icon id resolved by the icon registry (optional in v1). */
  readonly icon?: string;
}

/**
 * Tier-2 runtime contributions — the editor host aggregates these from every loaded plugin. Every field is
 * optional: a plugin contributes only the extension points it touches.
 */
export interface PluginRuntime {
  /** Inline formula/entity types, merged into the shared FormulaRegistry (not a private one). */
  readonly formulaTypes?: readonly FormulaType[];
  /** plugin_block NodeView factories, keyed by the `pluginType` they own. */
  readonly islandFactories?: Readonly<Record<string, PluginIslandFactory>>;
  /** Extra ProseMirror plugins (e.g. a paste-to-card handler). Built once per editor with the schema. */
  readonly editorPlugins?: (schema: DeltoSchema) => readonly Plugin[];
  /** Editor tool descriptors (toolbar / Deck / palette surfaces). */
  readonly tools?: readonly ToolDescriptor[];
}

/**
 * Tier-1 manifest. A pure-literal-friendly metadata record + a `load()` thunk for the tier-2 runtime.
 * Built-in (v1) manifests return the runtime synchronously; a future heavy plugin returns a Promise from
 * a dynamic import.
 */
export interface PluginManifest {
  /** Stable unique id (e.g. 'formula', 'link-card'). */
  readonly id: string;
  /** Human-readable name (used in the friendly unknown-block placeholder + palette). */
  readonly name: string;
  /** Declared capabilities (§4). Defaults to offline-only when omitted. */
  readonly capabilities?: readonly PluginCapability[];
  /** plugin_block `pluginType` key(s) this plugin owns — drives lazy-load + the named placeholder. */
  readonly blockTypes?: readonly string[];
  /** Discovery entry for the slash palette / new-note menu (A5). */
  readonly palette?: PluginPaletteEntry;
  /** Payload schema version for durability/migration (§6; lazy migrate-on-open arrives in A6). */
  readonly schemaVersion?: number;
  /** Tier-2 loader. Synchronous for built-ins (in-chunk); a Promise for lazy/heavy plugins. */
  readonly load: () => PluginRuntime | Promise<PluginRuntime>;
}

/** A manifest whose runtime loads synchronously — the v1 built-in case (eager, behavior-preserving). */
export function isEager(
  runtime: PluginRuntime | Promise<PluginRuntime>,
): runtime is PluginRuntime {
  return !(runtime !== null && typeof runtime === 'object' && 'then' in runtime);
}
