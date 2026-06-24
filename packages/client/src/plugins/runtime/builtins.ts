/**
 * The v1 built-in plugins (docs/specs/plugin-support.md §12-A1, §13 lean: a static first-party array,
 * shaped so a loadable/third-party manifest format is purely additive later). Each re-homes an extension
 * that already existed inline in the editor — formula, the link_card embed, and the core formatting tools —
 * behind the manifest spine, behavior-preserving. This re-home IS the de-risking proof for the framework.
 *
 * CAPABILITY MODEL — server-enforced (HC-A1). The manifest `capabilities` are REQUESTS, never grants: any
 * host capability is enforced SERVER-SIDE at its Worker route, keyed on the server-derived accountId
 * (requireAccountId) + a HOST-ASSIGNED pluginId — the client handle is only the seam, never the gate. None
 * of these three built-ins requests a server-enforced host capability: formula + tools are `offline`;
 * link_card is `online-only` but rides the EXISTING /api/unfurl route (its own SSRF/host guard), not a new
 * plugin-host capability. The first server-enforced capability (blob/R2) arrives with the attachment plugin
 * (A4), built on this same model — so enforcement is never retrofitted. `id` here is the host-assigned
 * pluginId (v1 first-party = authored in this array; a future loadable manifest gets its id assigned at
 * registration, never self-claimed).
 */
import type { PluginManifest } from './manifest.js';
import { mathType } from '../math/mathType.js';
import { hexColorType } from '../hexcolor/hexColorType.js';
import { LinkCardNodeView } from '../embeds/LinkCardNodeView.js';
import { linkCardPastePlugin } from '../embeds/index.js';
import { EDITOR_TOOLS } from '../../editor/editorTools.js';

/** Inline-formula framework — MATH + HEXCOLOR types merged into the shared FormulaRegistry. */
const formulaPlugin: PluginManifest = {
  id: 'formula',
  name: 'Formula',
  capabilities: ['offline'],
  schemaVersion: 1,
  load: () => ({ formulaTypes: [mathType, hexColorType] }),
};

/** Rich-embeds — the link_card plugin_block (bare-URL paste → card) + its NodeView. */
const linkCardPlugin: PluginManifest = {
  id: 'link-card',
  name: 'Link card',
  capabilities: ['online-only'], // fetches unfurl via the existing /api/unfurl route; degraded render = A3
  blockTypes: ['link_card'],
  schemaVersion: 1,
  load: () => ({
    islandFactories: {
      link_card: { create: (node, view, getPos) => new LinkCardNodeView(node, view, getPos) },
    },
    editorPlugins: (schema) => [linkCardPastePlugin(schema)],
  }),
};

/** Core formatting tools (bold / lists / inserts …) — the toolbar/Deck/palette descriptor list. */
const coreToolsPlugin: PluginManifest = {
  id: 'core-tools',
  name: 'Formatting tools',
  capabilities: ['offline'],
  load: () => ({ tools: EDITOR_TOOLS }),
};

export const BUILT_IN_PLUGINS: readonly PluginManifest[] = [formulaPlugin, linkCardPlugin, coreToolsPlugin];
