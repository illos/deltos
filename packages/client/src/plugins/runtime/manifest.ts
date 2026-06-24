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
/**
 * PRESENTATION capabilities (§4) — affect RENDER only (which form a read-only block draws), never access.
 * Consumed by shouldDegrade (A3). `offline` is the local-first default.
 */
export type PluginCapability = 'offline' | 'online-only' | 'collaborative';

/**
 * BACKEND-RESOURCE capability kinds (§7) — each is backed by a host resource (R2/D1/egress/…) and ENFORCED
 * at a server route. Distinct from presentation capabilities.
 */
export type HostCapabilityKind = 'blob' | 'records' | 'net' | 'compute' | 'schedule' | 'notify';

/**
 * A backend-resource capability declaration (HC-A1 type-contract, A4 #126). STRUCTURALLY distinct from the
 * presentation `capabilities` strings: a backend capability is a RECORD that MUST carry
 * `serverEnforced: true` — the type-level acknowledgement that this capability is enforced SERVER-SIDE at
 * its Worker route (keyed on the server-derived accountId + the host-assigned pluginId), NEVER by the
 * client. Consequences, by construction:
 *   - you cannot declare a backend resource as a bare presentation flag (different shape), and
 *   - you cannot omit the server-enforcement marker (`serverEnforced` is required and must be the literal
 *     `true`).
 * So "a backend capability enforced client-side / not bound to a server route" is UNREPRESENTABLE — A4's
 * `blob` (and every future host capability) can't be added client-only-enforced by accident. The MODEL
 * carries the invariant the docs used to; the actual enforcing route lives in the Worker (routes/blob.ts).
 */
export interface HostCapability {
  readonly kind: HostCapabilityKind;
  readonly serverEnforced: true;
}

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
  /**
   * Forward-migration for a stored payload authored at an OLDER schemaVersion (§6, A6 #128). Returns the
   * payload upgraded to the manifest's CURRENT schemaVersion. Run LAZILY on open (never a bulk pass, per the
   * disposable/clean-state posture + perf). Omit when the payload shape has never changed.
   */
  readonly migrate?: (payload: unknown, fromVersion: number) => unknown;
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
  /** Declared PRESENTATION capabilities (§4) — render degradation only. Defaults to offline when omitted. */
  readonly capabilities?: readonly PluginCapability[];
  /**
   * Declared BACKEND-RESOURCE capabilities (§7, HC-A1) — each is server-enforced at its Worker route. The
   * structural `{ kind, serverEnforced: true }` shape is the type-contract: a backend resource cannot be
   * declared as a bare presentation flag, so it is always bound to server-side enforcement.
   */
  readonly hostCapabilities?: readonly HostCapability[];
  /** plugin_block `pluginType` key(s) this plugin owns — drives lazy-load + the named placeholder. */
  readonly blockTypes?: readonly string[];
  /** Discovery entry for the slash palette / new-note menu (A5). */
  readonly palette?: PluginPaletteEntry;
  /** Payload schema version for durability/migration (§6; lazy migrate-on-open arrives in A6). */
  readonly schemaVersion?: number;
  /** Tier-2 loader. Synchronous for built-ins (in-chunk); a Promise for lazy/heavy plugins. */
  readonly load: () => PluginRuntime | Promise<PluginRuntime>;
}

/** The stored schema version of a block payload (a payload authored before versioning → treated as v1). */
export function payloadVersion(payload: unknown): number {
  if (payload && typeof payload === 'object') {
    const v = (payload as { schemaVersion?: unknown }).schemaVersion;
    if (typeof v === 'number') return v;
  }
  return 1;
}

/**
 * Lazily migrate a stored payload to `currentVersion` via the runtime's migrate fn (§6, A6). No-op when the
 * payload is already current or no migrate is provided. Stamps the new schemaVersion so it isn't re-migrated.
 * Pure (no PM / no registry) so any read path can call it. LOSSLESS — never drops the original on a missing
 * migrate; an unmigratable old block just renders as-is (durability §6).
 */
export function migratePayload(
  payload: unknown,
  currentVersion: number,
  migrate?: (p: unknown, from: number) => unknown,
): unknown {
  const from = payloadVersion(payload);
  if (from >= currentVersion || !migrate) return payload;
  const migrated = migrate(payload, from);
  return migrated && typeof migrated === 'object'
    ? { ...(migrated as object), schemaVersion: currentVersion }
    : migrated;
}

/** A manifest whose runtime loads synchronously — the v1 built-in case (eager, behavior-preserving). */
export function isEager(
  runtime: PluginRuntime | Promise<PluginRuntime>,
): runtime is PluginRuntime {
  return !(runtime !== null && typeof runtime === 'object' && 'then' in runtime);
}
