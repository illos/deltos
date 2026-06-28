import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';

/**
 * BLOB host-capability route tests (plugin-support §7, A4 #126) — the FIRST server-enforced plugin host
 * capability. The security model is the point (secSys re-audits): the R2 key is {server-derived
 * accountId}/{server-computed hash} → cross-account access is impossible by construction (BOLA-safe);
 * uploads hash-verify; downloads serve with safe headers (attachment + nosniff + sanitized type); size cap;
 * fail-closed when R2 is unbound or the caller is unauthenticated in prod.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const T = 30_000;

const migrations = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql', '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      sql, _params: [] as unknown[],
      bind(...p: unknown[]) { stmt._params = p; return stmt; },
      async first<T2>() { return (raw.prepare(sql).get(...(stmt._params as never[])) ?? null) as T2 | null; },
      async all<T2>() { return { results: raw.prepare(sql).all(...(stmt._params as never[])) as T2[] }; },
      async run() { const info = raw.prepare(sql).run(...(stmt._params as never[])); return { meta: { rows_written: info.changes } }; },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(prepared: Array<{ sql: string; _params: unknown[] }>) {
      return prepared.map((s) => { const info = raw.prepare(s.sql).run(...(s._params as never[])); return { meta: { rows_written: info.changes } }; });
    },
  } as unknown as D1Database;
}

function freshDb(): Database.Database {
  const raw = new Database(':memory:');
  for (const m of migrations) raw.exec(m);
  return raw;
}

/** Minimal in-memory R2 stub — put / head / get / list, enough to exercise the route's key + metadata use. */
function stubR2() {
  const store = new Map<string, { bytes: Uint8Array; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }>();
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array((value as ArrayBufferView).buffer);
      store.set(key, { bytes, ...(opts ?? {}) });
    },
    async head(key: string) {
      const o = store.get(key);
      return o ? { key, size: o.bytes.byteLength, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata } : null;
    },
    async get(key: string) {
      const o = store.get(key);
      return o ? { key, size: o.bytes.byteLength, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata, body: o.bytes } : null;
    },
    async list({ prefix }: { prefix?: string; cursor?: string } = {}) {
      const objects = [...store.entries()].filter(([k]) => !prefix || k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.bytes.byteLength }));
      return { objects, truncated: false as const };
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}

/**
 * Minimal stub of the Workers Images binding (file-notes spec §4 — the real binding has NO local impl, only
 * `wrangler dev --remote`, so this is the mockable seam). `input().transform().output()` records the requested
 * transform + format so a test can assert BOTH derivatives baked with their sizes/fits (FN-W2); `output()` can
 * be forced to throw to exercise the non-fatal path. `image()` hands back tiny fake-WebP bytes the route stores.
 */
function stubImages(opts: { fail?: boolean } = {}) {
  const bakes: Array<{ transform: Record<string, unknown>; format: string }> = [];
  const binding = {
    input() {
      let lastTransform: Record<string, unknown> = {};
      const chain = {
        transform(t: Record<string, unknown>) { lastTransform = t; return chain; },
        async output({ format }: { format: string }) {
          if (opts.fail) throw new Error('IMAGES transform failed');
          bakes.push({ transform: lastTransform, format });
          return {
            image: () => new Response(new Uint8Array([0x57, 0x45, 0x42, 0x50])).body, // "WEBP" placeholder bytes
            contentType: () => 'image/webp',
            response: () => new Response(new Uint8Array([0x57, 0x45, 0x42, 0x50])),
          };
        },
      };
      return chain;
    },
    async info() { return { format: 'image/heic', fileSize: 100, width: 10, height: 10 }; },
  };
  return { binding: binding as unknown as NonNullable<Env['IMAGES']>, bakes };
}

const makeEnv = (over: Partial<Env> = {}, raw?: Database.Database): Env =>
  ({ DB: d1Over(raw ?? freshDb()), ENVIRONMENT: 'development', AUTH_AUDIENCE: 'deltos.test', AUTH_PEPPER: 'p', TOTP_ENC_KEY: 'k', ...over }) as unknown as Env;

const upload = (env: Env, body: BodyInit, headers: Record<string, string> = {}) =>
  app.request('/api/plugin/blob', { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...headers }, body }, env);
const download = (env: Env, hash: string, headers: Record<string, string> = {}) =>
  app.request(`/api/plugin/blob/${hash}`, { method: 'GET', headers }, env);
const getVariant = (env: Env, hash: string, variant: 'thumb' | 'view', headers: Record<string, string> = {}) =>
  app.request(`/api/plugin/blob/${hash}/${variant}`, { method: 'GET', headers }, env);

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

async function signupToken(env: Env, username: string): Promise<string> {
  const res = await app.request('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'correct horse battery staple' }) }, env);
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

describe('POST/GET /api/plugin/blob — content-addressed storage', () => {
  it('dev: upload → download round-trips the exact bytes', async () => {
    const { bucket } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    const up = await upload(env, bytes(2048));
    expect(up.status).toBe(200);
    const { hash, size } = (await up.json()) as { hash: string; size: number };
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(size).toBe(2048);

    const down = await download(env, hash);
    expect(down.status).toBe(200);
    expect(new Uint8Array(await down.arrayBuffer())).toEqual(bytes(2048));
  });

  it('serves with SAFE headers: attachment + nosniff; non-image type sanitized to octet-stream', async () => {
    const { bucket } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    // upload an html file — must NEVER come back as text/html on the app origin
    const up = await upload(env, bytes(64), { 'x-blob-mime': 'text/html' });
    const { hash } = (await up.json()) as { hash: string };
    const down = await download(env, hash);
    expect(down.headers.get('content-disposition')).toBe('attachment');
    expect(down.headers.get('x-content-type-options')).toBe('nosniff');
    expect(down.headers.get('content-type')).toBe('application/octet-stream');
    // secSys #694 Q2: a fully-sandboxed, allow-nothing CSP on the blob response.
    expect(down.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('keeps a known-safe image type for inline preview', async () => {
    const { bucket } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    const up = await upload(env, bytes(64), { 'x-blob-mime': 'image/png' });
    const { hash } = (await up.json()) as { hash: string };
    const down = await download(env, hash);
    expect(down.headers.get('content-type')).toBe('image/png');
    expect(down.headers.get('content-disposition')).toBe('attachment'); // still attachment + nosniff
  });

  it('hash hint mismatch → 400 (integrity check; key always uses the server hash)', async () => {
    const { bucket } = stubR2();
    const res = await upload(makeEnv({ BLOBS: bucket }), bytes(128), { 'x-blob-sha256': 'deadbeef'.repeat(8) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('hash_mismatch');
  });

  it('dedup: same bytes uploaded twice → one stored object, same hash', async () => {
    const { bucket, store } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    const h1 = ((await (await upload(env, bytes(512))).json()) as { hash: string }).hash;
    const h2 = ((await (await upload(env, bytes(512))).json()) as { hash: string }).hash;
    expect(h1).toBe(h2);
    expect(store.size).toBe(1);
  });

  it('size cap: Content-Length precheck 413 before buffering', async () => {
    const { bucket } = stubR2();
    const res = await upload(makeEnv({ BLOBS: bucket }), bytes(1024), { 'content-length': String(26 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it('empty body → 400', async () => {
    const { bucket } = stubR2();
    expect((await upload(makeEnv({ BLOBS: bucket }), new Uint8Array(0))).status).toBe(400);
  });

  it('non-hex blob id on GET → 400 (only a clean SHA-256 hex is accepted; key cannot be steered)', async () => {
    const { bucket } = stubR2();
    expect((await download(makeEnv({ BLOBS: bucket }), 'g'.repeat(64))).status).toBe(400);
    expect((await download(makeEnv({ BLOBS: bucket }), 'abc')).status).toBe(400); // too short
  });

  it('R2 unbound → 503 fail-closed', async () => {
    expect((await upload(makeEnv({ BLOBS: undefined }), bytes(32))).status).toBe(503);
  });

  it('production + no bearer → 401 (fail-closed, no storage)', async () => {
    const { bucket } = stubR2();
    expect((await upload(makeEnv({ ENVIRONMENT: 'production', BLOBS: bucket }), bytes(32))).status).toBe(401);
  });

  it('BOLA: account B cannot read account A\'s blob (key is server-derived accountId/hash)', async () => {
    const raw = freshDb();
    const { bucket } = stubR2();
    const env = makeEnv({ ENVIRONMENT: 'production', BLOBS: bucket }, raw);
    const tokenA = await signupToken(env, 'alice');
    const tokenB = await signupToken(env, 'bob');

    const up = await upload(env, bytes(256), { Authorization: `Bearer ${tokenA}` });
    expect(up.status).toBe(200);
    const { hash } = (await up.json()) as { hash: string };

    // A reads its own blob — 200.
    expect((await download(env, hash, { Authorization: `Bearer ${tokenA}` })).status).toBe(200);
    // B asks for the SAME hash — but B's key prefix is its own accountId, so there is nothing there → 404.
    expect((await download(env, hash, { Authorization: `Bearer ${tokenB}` })).status).toBe(404);
  }, T);
});

/**
 * File-notes Slice 1 (spec §4) — dual-WebP pre-bake + inline derivative routes. The IMAGES binding is stubbed
 * (no local impl; real transform validated later on `wrangler dev --remote`). Gates: FN-W1 (degrade if unbound),
 * FN-W2 (both derivatives stored, idempotent, non-fatal), FN-W5 (inline + BOLA-safe derivative serving).
 */
describe('file-notes Slice 1 — dual-WebP pre-bake + inline derivative routes', () => {
  /** Find every derivative key (…thumb.webp / …view.webp) in the R2 store, independent of the dev accountId. */
  const derivKeys = (store: Map<string, unknown>) => [...store.keys()].filter((k) => k.endsWith('.webp'));

  it('FN-W2: image upload bakes BOTH derivatives with the right sizes/fits + webp format', async () => {
    const { bucket, store } = stubR2();
    const { binding, bakes } = stubImages();
    const env = makeEnv({ BLOBS: bucket, IMAGES: binding });

    const up = await upload(env, bytes(2048), { 'x-blob-mime': 'image/png' });
    expect(up.status).toBe(200);
    const { hash } = (await up.json()) as { hash: string };

    // Both derivative objects stored under the SAME accountId prefix, suffixed .thumb.webp / .view.webp.
    const keys = derivKeys(store);
    expect(keys.some((k) => k.endsWith(`/${hash}.thumb.webp`))).toBe(true);
    expect(keys.some((k) => k.endsWith(`/${hash}.view.webp`))).toBe(true);

    // Exactly two transforms, with the spec's geometry: 256² cover (thumb) + 2048² scale-down (view), both webp.
    expect(bakes).toHaveLength(2);
    expect(bakes).toContainEqual({ transform: { width: 256, height: 256, fit: 'cover' }, format: 'image/webp' });
    expect(bakes).toContainEqual({ transform: { width: 2048, height: 2048, fit: 'scale-down' }, format: 'image/webp' });
  });

  it('FN-W2: a NON-image upload bakes neither derivative', async () => {
    const { bucket, store } = stubR2();
    const { binding, bakes } = stubImages();
    const env = makeEnv({ BLOBS: bucket, IMAGES: binding });

    const up = await upload(env, bytes(512), { 'x-blob-mime': 'application/pdf' });
    expect(up.status).toBe(200);
    expect(bakes).toHaveLength(0);
    expect(derivKeys(store)).toHaveLength(0);
  });

  it('FN-W2: a transform failure is NON-FATAL — upload still 2xx and the original blob is retrievable', async () => {
    const { bucket, store } = stubR2();
    const { binding } = stubImages({ fail: true });
    const env = makeEnv({ BLOBS: bucket, IMAGES: binding });

    const up = await upload(env, bytes(1024), { 'x-blob-mime': 'image/jpeg' });
    expect(up.status).toBe(200); // the failed derive did NOT fail the upload
    const { hash } = (await up.json()) as { hash: string };

    // No derivative was stored, but the original blob is intact and downloadable.
    expect(derivKeys(store)).toHaveLength(0);
    const down = await download(env, hash);
    expect(down.status).toBe(200);
    expect(new Uint8Array(await down.arrayBuffer())).toEqual(bytes(1024));
  });

  it('FN-W1: IMAGES unbound → upload still succeeds, no derivative, no crash (degrades cleanly)', async () => {
    const { bucket, store } = stubR2();
    const env = makeEnv({ BLOBS: bucket, IMAGES: undefined });
    const up = await upload(env, bytes(256), { 'x-blob-mime': 'image/webp' });
    expect(up.status).toBe(200);
    expect(derivKeys(store)).toHaveLength(0);
  });

  it('FN-W2: re-uploading the same image is idempotent — derivatives baked once, not re-baked', async () => {
    const { bucket, store } = stubR2();
    const { binding, bakes } = stubImages();
    const env = makeEnv({ BLOBS: bucket, IMAGES: binding });

    const h1 = ((await (await upload(env, bytes(700), { 'x-blob-mime': 'image/png' })).json()) as { hash: string }).hash;
    const h2 = ((await (await upload(env, bytes(700), { 'x-blob-mime': 'image/png' })).json()) as { hash: string }).hash;
    expect(h1).toBe(h2);
    // The head()-precheck skips already-baked derivatives → still exactly two transforms + two stored objects.
    expect(bakes).toHaveLength(2);
    expect(derivKeys(store)).toHaveLength(2);
  });

  it('FN-W5: derivative GET serves the WebP INLINE (image/webp + nosniff), while the main blob GET stays attachment', async () => {
    const { bucket } = stubR2();
    const { binding } = stubImages();
    const env = makeEnv({ BLOBS: bucket, IMAGES: binding });
    const { hash } = (await (await upload(env, bytes(2048), { 'x-blob-mime': 'image/png' })).json()) as { hash: string };

    for (const variant of ['thumb', 'view'] as const) {
      const res = await getVariant(env, hash, variant);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      expect(res.headers.get('content-disposition')).toBe('inline'); // the ONE inline exception
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    }
    // The main blob GET is UNCHANGED — still forced to attachment (not weakened by the inline derivative routes).
    expect((await download(env, hash)).headers.get('content-disposition')).toBe('attachment');
  });

  it('FN-W5: derivative GET rejects a non-hex blob id → 400', async () => {
    const { bucket } = stubR2();
    const { binding } = stubImages();
    const env = makeEnv({ BLOBS: bucket, IMAGES: binding });
    expect((await getVariant(env, 'abc', 'thumb')).status).toBe(400);
    expect((await getVariant(env, 'g'.repeat(64), 'view')).status).toBe(400);
  });

  it('FN-W5: a missing derivative → 404 (e.g. an image whose bake failed)', async () => {
    const { bucket } = stubR2();
    const { binding } = stubImages({ fail: true });
    const env = makeEnv({ BLOBS: bucket, IMAGES: binding });
    const { hash } = (await (await upload(env, bytes(512), { 'x-blob-mime': 'image/png' })).json()) as { hash: string };
    expect((await getVariant(env, hash, 'thumb')).status).toBe(404);
  });

  it('FN-W5: BOLA — account B cannot read account A\'s derivative (own-prefix only → 404)', async () => {
    const raw = freshDb();
    const { bucket } = stubR2();
    const { binding } = stubImages();
    const env = makeEnv({ ENVIRONMENT: 'production', BLOBS: bucket, IMAGES: binding }, raw);
    const tokenA = await signupToken(env, 'alice');
    const tokenB = await signupToken(env, 'bob');

    const up = await upload(env, bytes(2048), { Authorization: `Bearer ${tokenA}`, 'x-blob-mime': 'image/png' });
    expect(up.status).toBe(200);
    const { hash } = (await up.json()) as { hash: string };

    // A reads its own derivative — 200; B asks the SAME hash but its prefix has nothing → 404.
    expect((await getVariant(env, hash, 'thumb', { Authorization: `Bearer ${tokenA}` })).status).toBe(200);
    expect((await getVariant(env, hash, 'thumb', { Authorization: `Bearer ${tokenB}` })).status).toBe(404);
    expect((await getVariant(env, hash, 'view', { Authorization: `Bearer ${tokenB}` })).status).toBe(404);
  }, T);
});
