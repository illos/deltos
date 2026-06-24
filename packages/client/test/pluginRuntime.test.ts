/**
 * #123 A1 — the plugin manifest spine. Proves the re-home is behavior-preserving: the built-in array
 * aggregates the EXISTING registries (formula types into one shared FormulaRegistry, the link_card island +
 * paste plugin, the core tool descriptors) exactly as the editor assembled them inline before — and the
 * two-tier loader (eager built-ins now, async heavy plugins later) is in place.
 */
import { describe, it, expect } from 'vitest';
import {
  PluginRegistry,
  collectEagerContributions,
  isEager,
  pluginRegistry,
  BUILT_IN_PLUGINS,
} from '../src/plugins/runtime/index.js';
import { getPluginIslandFactory } from '../src/editor/nodeviews/PluginIsland.js';
import { deltoSchema } from '../src/editor/schema.js';
import { mathType } from '../src/plugins/math/mathType.js';
import { hexColorType } from '../src/plugins/hexcolor/hexColorType.js';
import { EDITOR_TOOLS } from '../src/editor/editorTools.js';

describe('#123 plugin runtime — manifest spine', () => {
  it('re-homes formula, link-card, core-tools + the lazy attachment (+ its eager insert handler)', () => {
    expect(BUILT_IN_PLUGINS.map((m) => m.id)).toEqual([
      'formula', 'link-card', 'core-tools', 'attachment', 'attachment-insert',
    ]);
  });

  it('attachment is LAZY (async load) + declares the blob host capability via the server-enforced contract', () => {
    const attachment = BUILT_IN_PLUGINS.find((m) => m.id === 'attachment')!;
    expect(isEager(attachment.load())).toBe(false); // dynamic import → skipped at eager assembly
    expect(attachment.hostCapabilities).toEqual([{ kind: 'blob', serverEnforced: true }]);
    expect(attachment.capabilities).toEqual(['offline']); // the blob is cached → offline-capable render
  });

  it('aggregates formula types into ONE shared registry (math + hexcolor), not collapsed', () => {
    const c = collectEagerContributions(pluginRegistry);
    expect(c.formulaRegistry.get(mathType.id)).toBe(mathType);
    expect(c.formulaRegistry.get(hexColorType.id)).toBe(hexColorType);
  });

  it('aggregates the core tool descriptors (EDITOR_TOOLS)', () => {
    expect(collectEagerContributions(pluginRegistry).tools).toEqual([...EDITOR_TOOLS]);
  });

  it('registers the link_card island factory + contributes its paste plugin', () => {
    const c = collectEagerContributions(pluginRegistry); // side-effect: registers islands
    expect(getPluginIslandFactory('link_card')).toBeDefined();
    expect(c.buildEditorPlugins(deltoSchema).length).toBeGreaterThan(0); // the link_card paste handler
  });

  it('manifestForBlockType maps link_card → the link-card plugin (friendly-placeholder source)', () => {
    expect(pluginRegistry.manifestForBlockType('link_card')?.id).toBe('link-card');
    expect(pluginRegistry.manifestForBlockType('does-not-exist')).toBeUndefined();
  });

  it('capabilities are declared metadata: link_card online-only, formula/tools offline', () => {
    const byId = (id: string) => BUILT_IN_PLUGINS.find((m) => m.id === id);
    expect(byId('link-card')?.capabilities).toContain('online-only');
    expect(byId('formula')?.capabilities).toEqual(['offline']);
    expect(byId('core-tools')?.capabilities).toEqual(['offline']);
  });

  it('isEager: a sync runtime is eager, a promise is lazy (the two-tier discriminant)', async () => {
    expect(isEager({ tools: [] })).toBe(true);
    const lazy = Promise.resolve({ tools: [] });
    expect(isEager(lazy)).toBe(false);
    await lazy;
  });

  it('loadRuntime resolves a manifest runtime (cached once) and null for an unknown id', async () => {
    const reg = new PluginRegistry();
    let calls = 0;
    reg.registerManifest({
      id: 'x',
      name: 'X',
      load: () => {
        calls += 1;
        return { tools: [] };
      },
    });
    const r1 = await reg.loadRuntime('x');
    const r2 = await reg.loadRuntime('x');
    expect(r1).toBe(r2);
    expect(calls).toBe(1);
    expect(await reg.loadRuntime('missing')).toBeNull();
  });

  it('an async (lazy) manifest is SKIPPED at eager assembly — its block loads on demand', () => {
    const reg = new PluginRegistry();
    reg.registerManifest({ id: 'heavy', name: 'Heavy', load: () => Promise.resolve({ tools: [...EDITOR_TOOLS] }) });
    expect(collectEagerContributions(reg).tools).toEqual([]); // not pulled into the eager (in-chunk) set
  });
});
