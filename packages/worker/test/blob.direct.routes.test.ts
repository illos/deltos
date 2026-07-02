import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';

/**
 * Direct-to-R2 large-file upload — Slice 1 worker spine (direct-r2-upload.md §3, gates DR-1/DR-2/DR-QUOTA/DR-S).
 * The security model is the point (secSys re-audits): the presigned PUT key is server-fixed
 * `{bearer accountId}/{validated 64-hex hash}` (no client key-steering), and `x-amz-checksum-sha256` is signed,
 * derived server-side from the SAME hash → key + checksum inseparable. Confirm HEADs the real R2 size and enforces
 * the account quota POST-HOC with a delete-on-over rollback.
 *
 * The signer (aws4fetch) runs LOCALLY with no network, so these tests drive REAL SigV4 signing with dummy creds and
 * assert the URL/headers shape; the integrity control itself (R2 rejecting a checksum mismatch) is the live S3 smoke
 * after Jim provisions the bucket token + CORS — it cannot be unit-faked.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const T = 30_000;

const migrations = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql', '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql',
  '0013_agent-token-label.sql',
  '0014_grant-family-link.sql',
  '0015_audit-log.sql',
  '0016_usage-counter.sql',
  '0017_oauth-provider.sql', '0018_fts5-note-search.sql', '0019_note-routing-guide.sql',
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

/** In-memory R2 stub with the ops the direct path needs — head / delete / list / put (seed). */
function stubR2() {
  const store = new Map<string, { size: number; customMetadata?: Record<string, string> }>();
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView, opts?: { customMetadata?: Record<string, string> }) {
      const size = value instanceof ArrayBuffer ? value.byteLength : (value as ArrayBufferView).byteLength;
      store.set(key, { size, ...(opts ?? {}) });
    },
    async head(key: string) {
      const o = store.get(key);
      return o ? { key, size: o.size, customMetadata: o.customMetadata } : null;
    },
    async delete(key: string) { store.delete(key); },
    async list({ prefix }: { prefix?: string; cursor?: string } = {}) {
      const objects = [...store.entries()].filter(([k]) => !prefix || k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.size }));
      return { objects, truncated: false as const };
    },
  };
  /** Seed an object directly into R2 (simulates the client's PUT having already landed). */
  const seed = (key: string, size: number) => store.set(key, { size });
  return { bucket: bucket as unknown as R2Bucket, store, seed };
}

const S3 = { R2_ACCESS_KEY_ID: 'test-akid', R2_SECRET_ACCESS_KEY: 'test-secret', R2_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com' };

const makeEnv = (over: Partial<Env> = {}, raw?: Database.Database): Env =>
  ({ DB: d1Over(raw ?? freshDb()), ENVIRONMENT: 'development', AUTH_AUDIENCE: 'deltos.test', AUTH_PEPPER: 'p', TOTP_ENC_KEY: 'k', ...S3, ...over }) as unknown as Env;

const presign = (env: Env, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/api/plugin/blob/presign', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, env);
const confirm = (env: Env, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/api/plugin/blob/confirm', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, env);

const HASH = 'a'.repeat(64);
const BIG = 30 * 1024 * 1024; // > the 25 MB buffered cap → the direct path

async function signupToken(env: Env, username: string): Promise<{ token: string; accountId: string }> {
  const res = await app.request('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'correct horse battery staple' }) }, env);
  expect(res.status).toBe(201);
  const json = (await res.json()) as { token: string; accountId: string };
  return json;
}

describe('POST /api/plugin/blob/presign — authorize a direct-to-R2 PUT (DR-1 / DR-S)', () => {
  it('signs a presigned PUT whose key is exactly {accountId}/{hash} with a server-derived signed checksum', async () => {
    const { bucket } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    const res = await presign(env, { hash: HASH, size: BIG, mime: 'application/pdf' });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { url: string; headers: Record<string, string>; key: string; expiresIn: number };

    // The dev principal id is the fixed accountId; the key is server-fixed to {accountId}/{hash}.
    expect(out.key).toMatch(new RegExp(`/${HASH}$`));
    const u = new URL(out.url);
    expect(u.origin).toBe('https://acct.r2.cloudflarestorage.com');
    expect(u.pathname).toBe(`/deltos-blobs/${out.key}`);

    // The checksum is base64 of the 32 raw hash bytes — NOT a second client field — and is a SIGNED header.
    const expectedB64 = Buffer.from(HASH, 'hex').toString('base64');
    expect(out.headers['x-amz-checksum-sha256']).toBe(expectedB64);
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toContain('x-amz-checksum-sha256');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(u.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(out.expiresIn).toBe(3600);
  });

  it('DR-S: a client-supplied key/prefix is ignored — the key is always {bearer accountId}/{validated hash}', async () => {
    const { bucket } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    // Attacker-style body trying to steer the key and decouple the checksum — all extra fields ignored.
    const res = await presign(env, { hash: HASH, size: BIG, mime: 'application/pdf', key: 'victim/evil', accountId: 'victim', 'x-amz-checksum-sha256': 'BADBADBAD' });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { url: string; headers: Record<string, string>; key: string };
    expect(out.key.endsWith(`/${HASH}`)).toBe(true);
    expect(out.key.startsWith('victim/')).toBe(false);
    expect(out.url).not.toContain('victim');
    // The checksum is derived from the validated hash, not echoed from the client field.
    expect(out.headers['x-amz-checksum-sha256']).toBe(Buffer.from(HASH, 'hex').toString('base64'));
  });

  it('DR-1: two different accounts presigning the SAME hash get URLs under their OWN prefix (no cross-account key)', async () => {
    const raw = freshDb();
    const { bucket } = stubR2();
    const env = makeEnv({ ENVIRONMENT: 'production', BLOBS: bucket }, raw);
    const a = await signupToken(env, 'alice');
    const b = await signupToken(env, 'bob');
    expect(a.accountId).not.toBe(b.accountId);

    const ka = ((await (await presign(env, { hash: HASH, size: BIG, mime: 'application/pdf' }, { Authorization: `Bearer ${a.token}` })).json()) as { key: string }).key;
    const kb = ((await (await presign(env, { hash: HASH, size: BIG, mime: 'application/pdf' }, { Authorization: `Bearer ${b.token}` })).json()) as { key: string }).key;
    expect(ka).toBe(`${a.accountId}/${HASH}`);
    expect(kb).toBe(`${b.accountId}/${HASH}`);
    expect(ka).not.toBe(kb);
  }, T);

  it('requires auth (production + no bearer → 401)', async () => {
    const { bucket } = stubR2();
    const res = await presign(makeEnv({ ENVIRONMENT: 'production', BLOBS: bucket }), { hash: HASH, size: BIG, mime: 'application/pdf' });
    expect(res.status).toBe(401);
  });

  it('rejects a non-hex / malformed hash → 400 (key cannot be steered)', async () => {
    const { bucket } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    expect((await presign(env, { hash: 'g'.repeat(64), size: BIG, mime: 'application/pdf' })).status).toBe(400);
    expect((await presign(env, { hash: 'abc', size: BIG, mime: 'application/pdf' })).status).toBe(400);
    expect((await presign(env, { size: BIG, mime: 'application/pdf' })).status).toBe(400);
  });

  it('rejects a size within the buffered range (≤ 25 MB) → 400 (that is a client routing bug; use POST /)', async () => {
    const { bucket } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    expect((await presign(env, { hash: HASH, size: 25 * 1024 * 1024, mime: 'application/pdf' })).status).toBe(400);
    expect((await presign(env, { hash: HASH, size: 1024, mime: 'application/pdf' })).status).toBe(400);
    expect((await presign(env, { hash: HASH, size: 0, mime: 'application/pdf' })).status).toBe(400);
  });

  it('rejects an oversize file (> MAX_DIRECT_BLOB_SIZE, 2 GB) → 413', async () => {
    const { bucket } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    expect((await presign(env, { hash: HASH, size: 3 * 1024 * 1024 * 1024, mime: 'application/pdf' })).status).toBe(413);
  });

  it('requires a mime → 400', async () => {
    const { bucket } = stubR2();
    expect((await presign(makeEnv({ BLOBS: bucket }), { hash: HASH, size: BIG })).status).toBe(400);
  });

  it('advisory pre-flight quota: a declared size that blows the quota → 413 before any presign', async () => {
    const { bucket, seed } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    // Seed near-full usage under the dev account prefix, then declare a size that tips it over.
    const me = ((await (await presign(env, { hash: HASH, size: BIG, mime: 'application/pdf' })).json()) as { key: string }).key;
    const accountId = me.slice(0, me.indexOf('/'));
    seed(`${accountId}/${'b'.repeat(64)}`, 10 * 1024 * 1024 * 1024 - 1024); // ~quota
    const res = await presign(env, { hash: HASH, size: BIG, mime: 'application/pdf' });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('quota_exceeded');
  });

  it('Tier-2 (ROAD-0005 P4): 429 quota_exceeded once the daily blobWrite cap is reached — before signing', async () => {
    const raw = freshDb();
    const { bucket } = stubR2();
    const env = makeEnv({ BLOBS: bucket }, raw);
    const today = new Date().toISOString().slice(0, 10);
    // Pre-seed the dev account's counter AT the cap (2000/day) so the presign is over budget.
    raw.prepare(
      `INSERT INTO usageCounter (accountId, metric, dayBucket, count, updatedAt) VALUES (?, 'blobWrite', ?, 2000, ?)`,
    ).run('local-account', today, new Date().toISOString());
    const res = await presign(env, { hash: HASH, size: BIG, mime: 'application/pdf' });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('quota_exceeded');
  });

  it('Tier-2: a presign under quota succeeds and increments the usageCounter blobWrite row', async () => {
    const raw = freshDb();
    const { bucket } = stubR2();
    const env = makeEnv({ BLOBS: bucket }, raw);
    const today = new Date().toISOString().slice(0, 10);
    const res = await presign(env, { hash: HASH, size: BIG, mime: 'application/pdf' });
    expect(res.status).toBe(200);
    const row = raw
      .prepare('SELECT count FROM usageCounter WHERE accountId=? AND metric=? AND dayBucket=?')
      .get('local-account', 'blobWrite', today) as { count: number } | undefined;
    expect(row?.count).toBe(1);
  });

  it('fail-closed when the R2 S3 credentials are unset → 503', async () => {
    const { bucket } = stubR2();
    const env = makeEnv({ BLOBS: bucket, R2_ACCESS_KEY_ID: undefined, R2_SECRET_ACCESS_KEY: undefined });
    const res = await presign(env, { hash: HASH, size: BIG, mime: 'application/pdf' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('blob_direct_not_configured');
  });

  it('R2 unbound → 503 fail-closed', async () => {
    expect((await presign(makeEnv({ BLOBS: undefined }), { hash: HASH, size: BIG, mime: 'application/pdf' })).status).toBe(503);
  });
});

describe('POST /api/plugin/blob/confirm — record + quota rollback (DR-2 / DR-QUOTA)', () => {
  /** Resolve the dev account prefix the route writes under (so a test can seed the matching key). */
  async function devAccountId(env: Env): Promise<string> {
    const key = ((await (await presign(env, { hash: HASH, size: BIG, mime: 'application/pdf' })).json()) as { key: string }).key;
    return key.slice(0, key.indexOf('/'));
  }

  it('DR-2: HEADs {accountId}/{hash} and returns {hash, size} with the REAL R2-measured size', async () => {
    const { bucket, seed } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    const accountId = await devAccountId(env);
    seed(`${accountId}/${HASH}`, 42_000_000); // the size R2 actually measured, not the client's claim
    const res = await confirm(env, { hash: HASH, mime: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hash: HASH, size: 42_000_000 });
  });

  it('DR-2: 404 when the object is absent (the client never actually uploaded — no note for a missing blob)', async () => {
    const { bucket } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    const res = await confirm(env, { hash: HASH, mime: 'application/pdf' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('DR-QUOTA: an upload that pushes the account over quota is DELETED (rollback) and 413', async () => {
    const { bucket, store, seed } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    const accountId = await devAccountId(env);
    // Existing usage already AT quota, plus the just-uploaded object on top → total over.
    seed(`${accountId}/${'c'.repeat(64)}`, 10 * 1024 * 1024 * 1024);
    seed(`${accountId}/${HASH}`, BIG);
    const res = await confirm(env, { hash: HASH, mime: 'application/pdf' });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('quota_exceeded');
    // Rolled back — the over-quota object is gone.
    expect(store.has(`${accountId}/${HASH}`)).toBe(false);
  });

  it('DR-QUOTA: an in-quota upload is kept and returned', async () => {
    const { bucket, store, seed } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    const accountId = await devAccountId(env);
    seed(`${accountId}/${HASH}`, BIG);
    const res = await confirm(env, { hash: HASH, mime: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(store.has(`${accountId}/${HASH}`)).toBe(true);
  });

  it('DR-QUOTA dedup edge: a re-confirm of already-stored bytes (zero net usage) is NOT rolled back', async () => {
    const { bucket, store, seed } = stubR2();
    const env = makeEnv({ BLOBS: bucket });
    const accountId = await devAccountId(env);
    // The object exists and total usage is exactly AT quota (not over) — a same-key dedup adds nothing.
    seed(`${accountId}/${HASH}`, 10 * 1024 * 1024 * 1024);
    const res = await confirm(env, { hash: HASH, mime: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(store.has(`${accountId}/${HASH}`)).toBe(true);
  });

  it('rejects a non-hex hash → 400', async () => {
    const { bucket } = stubR2();
    expect((await confirm(makeEnv({ BLOBS: bucket }), { hash: 'abc', mime: 'application/pdf' })).status).toBe(400);
  });

  it('requires auth (production + no bearer → 401)', async () => {
    const { bucket } = stubR2();
    expect((await confirm(makeEnv({ ENVIRONMENT: 'production', BLOBS: bucket }), { hash: HASH, mime: 'application/pdf' })).status).toBe(401);
  });

  it('R2 unbound → 503 fail-closed', async () => {
    expect((await confirm(makeEnv({ BLOBS: undefined }), { hash: HASH, mime: 'application/pdf' })).status).toBe(503);
  });

  it('BOLA: confirm only ever HEADs the caller\'s OWN prefix — account B cannot confirm A\'s object', async () => {
    const raw = freshDb();
    const { bucket, seed } = stubR2();
    const env = makeEnv({ ENVIRONMENT: 'production', BLOBS: bucket }, raw);
    const a = await signupToken(env, 'alice');
    const b = await signupToken(env, 'bob');
    seed(`${a.accountId}/${HASH}`, BIG); // only A has the object
    // B confirms the same hash — its own prefix has nothing → 404 (cannot observe or claim A's blob).
    expect((await confirm(env, { hash: HASH, mime: 'application/pdf' }, { Authorization: `Bearer ${b.token}` })).status).toBe(404);
    // A confirms its own → 200.
    expect((await confirm(env, { hash: HASH, mime: 'application/pdf' }, { Authorization: `Bearer ${a.token}` })).status).toBe(200);
  }, T);
});
