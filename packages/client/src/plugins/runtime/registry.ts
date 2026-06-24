/**
 * Plugin registry + loader (docs/specs/plugin-support.md §1, §3). Holds the tier-1 manifests and APPLIES
 * their tier-2 runtime contributions to the EXISTING registries (aggregate, don't collapse — §13):
 *   - formula types → a shared FormulaRegistry
 *   - plugin_block node-views → the PluginIsland map (so the friendly unknown placeholder still covers
 *     not-yet-loaded blocks, §6)
 *   - editor plugins / tools → concatenated for the host to assemble
 *
 * Behavior-preserving by construction: the eager (synchronous) built-ins are aggregated at editor-init in
 * the editor chunk — the same plugins/node-views the editor assembled inline before, just sourced through
 * the manifest. Async runtimes (future heavy plugins) are skipped at eager assembly and loaded on demand.
 */
import type { Plugin } from 'prosemirror-state';
import type { DeltoSchema } from '../../editor/schema.js';
import { createFormulaRegistry, type FormulaRegistry } from '../formula/index.js';
import { registerPluginIsland } from '../../editor/nodeviews/PluginIsland.js';
import type { ToolDescriptor } from '../../editor/editorTools.js';
import { isEager, type PluginManifest, type PluginRuntime } from './manifest.js';

export class PluginRegistry {
  private readonly manifests = new Map<string, PluginManifest>();
  private readonly byBlockType = new Map<string, PluginManifest>();
  private readonly runtimeCache = new Map<string, PluginRuntime>();

  /** Register a tier-1 manifest (idempotent per id; a re-register replaces). */
  registerManifest(manifest: PluginManifest): void {
    this.manifests.set(manifest.id, manifest);
    for (const type of manifest.blockTypes ?? []) this.byBlockType.set(type, manifest);
  }

  /** All registered manifests — the discovery layer (palette A5, placeholder naming §6). */
  allManifests(): PluginManifest[] {
    return [...this.manifests.values()];
  }

  /** The manifest that owns a plugin_block `pluginType`, if any (drives the friendly placeholder). */
  manifestForBlockType(type: string): PluginManifest | undefined {
    return this.byBlockType.get(type);
  }

  manifestById(id: string): PluginManifest | undefined {
    return this.manifests.get(id);
  }

  /**
   * Load a plugin's tier-2 runtime on demand (cached). Built-ins resolve synchronously; lazy plugins
   * dynamic-`import()`. Returns null for an unknown id.
   */
  async loadRuntime(id: string): Promise<PluginRuntime | null> {
    const cached = this.runtimeCache.get(id);
    if (cached) return cached;
    const manifest = this.manifests.get(id);
    if (!manifest) return null;
    const runtime = await manifest.load();
    this.runtimeCache.set(id, runtime);
    // A lazily-loaded runtime's island NodeViews must become live so its blocks render once loaded
    // (idempotent — the same factory re-set). Editor-plugin/tool contributions can't be retro-added to a
    // live EditorView, so those only apply via eager assembly; islands resolve per-node-view-creation, so
    // registering here + a node-view refresh upgrades a placeholder block to the real view.
    for (const [type, factory] of Object.entries(runtime.islandFactories ?? {})) {
      registerPluginIsland(type, factory);
    }
    return runtime;
  }
}

/**
 * The aggregated editor contributions the host assembles at view-construction. Mirrors exactly what the
 * editor used to build inline (formula registry + plugins, the link_card paste plugin, the tool list).
 */
export interface EditorContributions {
  /** Formula registry built from every eager plugin's formula types (replaces createDefaultFormulaRegistry). */
  readonly formulaRegistry: FormulaRegistry;
  /** Build each eager plugin's extra ProseMirror plugins for this schema, in registration order. */
  buildEditorPlugins(schema: DeltoSchema): Plugin[];
  /** Every eager plugin's editor tool descriptors, in registration order. */
  readonly tools: readonly ToolDescriptor[];
}

/**
 * Collect the EAGER contributions: load every manifest whose runtime is synchronous and aggregate. Eager
 * island factories are registered into the PluginIsland map as a side-effect (so buildPluginIslandNodeViews
 * resolves them, and unregistered/not-yet-loaded types fall back to the friendly placeholder). Async
 * runtimes are intentionally skipped here — their blocks load on demand.
 */
export function collectEagerContributions(registry: PluginRegistry): EditorContributions {
  const formulaRegistry = createFormulaRegistry();
  const pluginBuilders: Array<(schema: DeltoSchema) => readonly Plugin[]> = [];
  const tools: ToolDescriptor[] = [];

  for (const manifest of registry.allManifests()) {
    const loaded = manifest.load();
    if (!isEager(loaded)) continue; // lazy/heavy plugin — loaded on demand, not at editor-init
    applyRuntime(loaded, formulaRegistry, pluginBuilders, tools);
  }

  return {
    formulaRegistry,
    tools,
    buildEditorPlugins(schema) {
      return pluginBuilders.flatMap((build) => [...build(schema)]);
    },
  };
}

function applyRuntime(
  runtime: PluginRuntime,
  formulaRegistry: FormulaRegistry,
  pluginBuilders: Array<(schema: DeltoSchema) => readonly Plugin[]>,
  tools: ToolDescriptor[],
): void {
  for (const type of runtime.formulaTypes ?? []) formulaRegistry.register(type);
  for (const [pluginType, factory] of Object.entries(runtime.islandFactories ?? {})) {
    registerPluginIsland(pluginType, factory);
  }
  if (runtime.editorPlugins) pluginBuilders.push(runtime.editorPlugins);
  if (runtime.tools) tools.push(...runtime.tools);
}
