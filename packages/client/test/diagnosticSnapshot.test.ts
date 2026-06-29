/**
 * Diagnostic-snapshot builder — pure collector unit tests (no DOM, no Dexie).
 *
 * Covers the contract that matters for handing this zip to support:
 *   DS-1  output has indexeddb.json / manifest.json / localstorage.json
 *   DS-2  blobCache rows are dumped METADATA ONLY — no `bytes`; an ArrayBuffer elsewhere → placeholder
 *   DS-3  SECURITY: the auth-store bearer token is ABSENT, and a token/secret-keyed localStorage entry
 *         is REDACTED — while note CONTENT (incl. a stuck/malformed op) IS present
 *   DS-4  manifest carries the sync block (queueDepth/lastSeq/lastError/status) + account identifiers
 *         with keyIdPresent as a boolean (never the keyId value)
 */
import { describe, it, expect } from 'vitest';
import { collectSnapshotFiles, zipSnapshotFiles, type SnapshotInputs } from '../src/lib/diagnosticSnapshot.js';
import { unzipSync, strFromU8 } from 'fflate';

const SECRET_TOKEN = 'BEARER-eyJhbGciOi-SUPER-SECRET-TOKEN';

function makeTable(name: string, rows: unknown[]) {
  return { name, toArray: async () => rows };
}

function makeStorage(entries: Record<string, string>) {
  const keys = Object.keys(entries);
  return {
    length: keys.length,
    key: (i: number) => keys[i] ?? null,
    getItem: (k: string) => (k in entries ? entries[k]! : null),
  };
}

function makeInputs(): SnapshotInputs {
  return {
    exportedAt: '2026-06-29T10:00:00.000Z',
    appVersion: 'test-sha',
    buildTime: '2026-06-29T09:00:00.000Z',
    dexieSchemaVersion: 9,
    tables: [
      makeTable('notes', [
        { id: 'n1', title: 'My note', body: { type: 'doc', content: 'STUCK-MALFORMED-OP-CONTENT' } },
      ]),
      // blobCache carries a real ArrayBuffer in `bytes` — must be dropped to metadata only.
      makeTable('blobCache', [
        { accountId: 'acct-1', resourceKey: 'hash:view', bytes: new ArrayBuffer(2048), mime: 'image/webp', size: 2048, lastAccess: 123 },
      ]),
      // A binary blob nested in a non-blobCache row must collapse to a placeholder (not bloat / choke).
      makeTable('weird', [{ id: 'w1', blob: new Uint8Array([1, 2, 3, 4]).buffer }]),
    ],
    storage: makeStorage({
      'deltos.theme': 'ember-dark',
      'deltos.sync.cursor.v2.acct-1': '42',
      'deltos.authToken': SECRET_TOKEN,
      'some.secret.thing': 'value-does-not-matter',
    }),
    auth: { bearerToken: SECRET_TOKEN, accountId: 'acct-1', username: 'alice', keyId: null },
    sync: { queueDepth: 3, lastSeq: 42, lastError: 'push 400', status: 'error' },
    env: {
      servedBundle: '/assets/index-abc123.js',
      userAgent: 'jsdom',
      platform: 'test',
      language: 'en',
      online: true,
      viewport: { width: 390, height: 844 },
      serviceWorker: { registered: true, hasController: true, controllerScriptURL: '/sw.js', waiting: false },
    },
  };
}

describe('DS-1 — three named files', () => {
  it('produces indexeddb.json, manifest.json, localstorage.json', async () => {
    const files = await collectSnapshotFiles(makeInputs());
    expect(Object.keys(files).sort()).toEqual(['indexeddb.json', 'localstorage.json', 'manifest.json']);
  });
});

describe('DS-2 — binary omission', () => {
  it('dumps blobCache metadata only (no bytes) and placeholders other ArrayBuffers', async () => {
    const files = await collectSnapshotFiles(makeInputs());
    const idb = JSON.parse(files['indexeddb.json']!);

    const blobRow = idb.tables.blobCache[0];
    expect(blobRow.bytes).toBeUndefined();
    expect(blobRow).toMatchObject({ accountId: 'acct-1', resourceKey: 'hash:view', size: 2048, mime: 'image/webp', lastAccess: 123 });

    // The nested binary in a non-blobCache row is replaced with a compact placeholder.
    expect(idb.tables.weird[0].blob).toEqual({ __omitted: 'ArrayBuffer', byteLength: 4 });

    // Schema version is recorded.
    expect(idb.dexieSchemaVersion).toBe(9);
  });
});

describe('DS-3 — SECURITY: no token/secret leaks; note content kept', () => {
  it('drops the bearer token, redacts credential-keyed localStorage, keeps note content', async () => {
    const files = await collectSnapshotFiles(makeInputs());
    const whole = files['indexeddb.json']! + files['manifest.json']! + files['localstorage.json']!;

    // The bearer token never appears ANYWHERE in the output (the load-bearing assertion).
    expect(whole).not.toContain(SECRET_TOKEN);

    // localStorage credential entries are redacted; an innocuous setting is kept verbatim.
    const ls = JSON.parse(files['localstorage.json']!);
    expect(ls['deltos.authToken']).toBe('[redacted]');
    expect(ls['some.secret.thing']).toBe('[redacted]');
    expect(ls['deltos.theme']).toBe('ember-dark');
    expect(ls['deltos.sync.cursor.v2.acct-1']).toBe('42');

    // Note content — including the stuck/malformed op — IS present (the whole point of the tool).
    expect(files['indexeddb.json']).toContain('STUCK-MALFORMED-OP-CONTENT');
  });
});

describe('DS-4 — manifest sync + account block', () => {
  it('carries the sync diagnostics and account identifiers (keyIdPresent boolean, no keyId value)', async () => {
    const files = await collectSnapshotFiles(makeInputs());
    const manifest = JSON.parse(files['manifest.json']!);

    expect(manifest.sync).toEqual({ queueDepth: 3, lastSeq: 42, lastError: 'push 400', status: 'error' });
    expect(manifest.account).toEqual({ accountId: 'acct-1', username: 'alice', keyIdPresent: false });
    expect(manifest.appVersion).toBe('test-sha');
    expect(manifest.servedBundle).toBe('/assets/index-abc123.js');
    // No bearerToken key anywhere in the manifest.
    expect(JSON.stringify(manifest)).not.toContain('bearerToken');
  });
});

describe('DS-5 — zip round-trips', () => {
  it('zips the three files into a readable archive', async () => {
    const files = await collectSnapshotFiles(makeInputs());
    const zipped = zipSnapshotFiles(files);
    const out = unzipSync(zipped);
    expect(Object.keys(out).sort()).toEqual(['indexeddb.json', 'localstorage.json', 'manifest.json']);
    expect(strFromU8(out['manifest.json']!)).toContain('"queueDepth": 3');
  });
});
