/**
 * #128 A6 — versioning / lazy migrate-on-open (§6). A block stored at an older schemaVersion upgrades when
 * its (newer) plugin opens it: the manifest declares the CURRENT version, the runtime provides migrate(),
 * and the migration runs lazily — never a bulk pass, never lossy.
 */
import { describe, it, expect } from 'vitest';
import { PluginRegistry } from '../src/plugins/runtime/registry.js';
import { payloadVersion, migratePayload } from '../src/plugins/runtime/manifest.js';

describe('#128 migratePayload (pure)', () => {
  it('payloadVersion: a pre-versioning payload is v1; an explicit version wins', () => {
    expect(payloadVersion({ a: 1 })).toBe(1);
    expect(payloadVersion({ a: 1, schemaVersion: 3 })).toBe(3);
    expect(payloadVersion(null)).toBe(1);
  });

  it('migrates an older payload to current + stamps the version', () => {
    const out = migratePayload({ name: 'x' }, 2, (p, from) => ({ ...(p as object), migratedFrom: from }));
    expect(out).toEqual({ name: 'x', migratedFrom: 1, schemaVersion: 2 });
  });

  it('no-op when already current, or when no migrate fn (lossless — returns the original)', () => {
    expect(migratePayload({ name: 'x', schemaVersion: 2 }, 2, (p) => ({ ...(p as object), touched: true }))).toEqual({ name: 'x', schemaVersion: 2 });
    expect(migratePayload({ name: 'x' }, 2, undefined)).toEqual({ name: 'x' }); // no migrate → unchanged, not dropped
  });
});

describe('#128 registry.migrateBlock (lazy-on-open)', () => {
  function regWithV2() {
    const reg = new PluginRegistry();
    reg.registerManifest({
      id: 'vplug',
      name: 'Versioned',
      blockTypes: ['vblock'],
      schemaVersion: 2,
      load: () => ({ migrate: (p, from) => ({ ...(p as object), upgraded: true, was: from }) }),
    });
    return reg;
  }

  it('returns the payload unchanged until the runtime is loaded (migrate lives in the runtime)', () => {
    const reg = regWithV2();
    expect(reg.migrateBlock('vblock', { x: 1 })).toEqual({ x: 1 });
  });

  it('after loadRuntime, a v1 payload migrates to v2 and is stamped', async () => {
    const reg = regWithV2();
    await reg.loadRuntime('vplug');
    expect(reg.migrateBlock('vblock', { x: 1 })).toEqual({ x: 1, upgraded: true, was: 1, schemaVersion: 2 });
    // already-current payload is untouched
    expect(reg.migrateBlock('vblock', { x: 1, schemaVersion: 2 })).toEqual({ x: 1, schemaVersion: 2 });
  });

  it('unknown block type / no declared version → payload unchanged', () => {
    const reg = regWithV2();
    expect(reg.migrateBlock('nope', { x: 1 })).toEqual({ x: 1 });
  });
});
