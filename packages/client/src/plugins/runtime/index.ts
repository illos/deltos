/**
 * Plugin runtime — public API (docs/specs/plugin-support.md §1, §3, §12-A1). The editor host imports the
 * shared `pluginRegistry` (built-ins pre-registered) + `collectEagerContributions` to assemble its plugins
 * through the manifest spine instead of inline. Everything below it (the formula registry, the PluginIsland
 * map, the tool list) already existed — this is the missing aggregation layer.
 */
import { PluginRegistry } from './registry.js';
import { BUILT_IN_PLUGINS } from './builtins.js';

export type {
  PluginManifest,
  PluginRuntime,
  PluginCapability,
  PluginPaletteEntry,
} from './manifest.js';
export { isEager } from './manifest.js';
export { PluginRegistry, collectEagerContributions } from './registry.js';
export type { EditorContributions } from './registry.js';
export { BUILT_IN_PLUGINS } from './builtins.js';

/**
 * The process-wide registry with the v1 built-ins registered (tier-1, in the editor chunk — NOT the entry
 * bundle, per the perf gate). The editor reads its eager contributions at view-construction.
 */
export const pluginRegistry = new PluginRegistry();
for (const manifest of BUILT_IN_PLUGINS) pluginRegistry.registerManifest(manifest);
