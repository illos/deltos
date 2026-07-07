/**
 * Route + security tests for the MCP FILE write-tools (agentTools.ts / write-tools.md): POST /api/mcp,
 * JSON-RPC tools/call for create_file_note + embed_file. Both ride the SAME `attachment` block and the SAME
 * `storeBlob` the upload route uses (server SHA-256, BOLA `{accountId}/{hash}` key, blobWrite quota, dedup,
 * image bake). The bar is the security contract, not just the happy path:
 *   - a WRITE-scoped token can create a file-note (fileType marker + one attachment block, blob stored) and
 *     embed a file into an existing note (append one attachment block, CAS on version);
 *   - the boundary rejects an oversize payload, malformed base64, and a bad/empty mime (schema-first);
 *   - 🚨 BOLA: account B's write token cannot embed into account A's note (inherited isolation → not found)
 *     AND never stores bytes for it (ownership is checked before the upload);
 *   - image vs non-image both store (rendering is client-side — we assert the stored block content);
 *   - the aggregation seam surfaces the two tools for a write token and HIDES them from a read-only token.
 *
 * Self-contained harness: better-sqlite3 → D1 shim + an in-memory R2 stub + the real Hono app.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { signupToken } from './helpers/passwordToken.js';
import type { AgentWriteOpt } from '@deltos/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql', '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql', '0013_agent-token-label.sql', '0014_grant-family-link.sql',
  '0015_audit-log.sql', '0016_usage-counter.sql', '0017_oauth-provider.sql', '0018_fts5-note-search.sql', '0019_note-routing-guide.sql', '0020_grant-sets.sql', '0021_oauth-refresh-token.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      sql,
      _params: [] as unknown[],
      bind(...p: unknown[]) { stmt._params = p; return stmt; },
      async first<T>() { return (raw.prepare(sql).get(...(stmt._params as never[])) ?? null) as T | null; },
      async all<T>() { return { results: raw.prepare(sql).all(...(stmt._params as never[])) as T[] }; },
      async run() { const info = raw.prepare(sql).run(...(stmt._params as never[])); return { meta: { rows_written: info.changes } }; },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(prepared: Array<{ sql: string; _params: unknown[] }>) {
      return prepared.map((s) => {
        const info = raw.prepare(s.sql).run(...(s._params as never[]));
        return { meta: { rows_written: info.changes } };
      });
    },
  } as unknown as D1Database;
}

/** Minimal in-memory R2 — enough for storeBlob (head / list-by-prefix / put). No IMAGES → the bake no-ops. */
function stubR2() {
  const store = new Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string> }>();
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView, opts?: { customMetadata?: Record<string, string> }) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array((value as ArrayBufferView).buffer);
      store.set(key, { bytes, customMetadata: opts?.customMetadata });
    },
    async head(key: string) {
      const o = store.get(key);
      return o ? { key, size: o.bytes.byteLength, customMetadata: o.customMetadata } : null;
    },
    async list({ prefix }: { prefix?: string; cursor?: string } = {}) {
      const objects = [...store.entries()].filter(([k]) => !prefix || k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.bytes.byteLength }));
      return { objects, truncated: false as const };
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}

const AUD = 'deltos.mcp.files';
const makeEnv = (raw: Database.Database, bucket?: R2Bucket): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, AUTH_PEPPER: 'mcp-files-pepper', BLOBS: bucket } as unknown as Env);

interface JsonRpcResult { jsonrpc: string; id: unknown; result?: any; error?: { code: number; message: string } }

const rpc = (env: Env, payload: unknown, token?: string) =>
  app.request('/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  }, env);

/** tools/call → the FULL JSON-RPC response (so tests can read result.result OR error). */
const callRaw = (env: Env, token: string, name: string, args: unknown) =>
  rpc(env, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, token)
    .then((r) => r.json() as Promise<JsonRpcResult>);

/** tools/call → the McpToolResult (result.result). */
const call = (env: Env, token: string, name: string, args: unknown) =>
  callRaw(env, token, name, args).then((b) => b.result);

async function getNote(env: Env, token: string, id: string): Promise<any> {
  const r = await call(env, token, 'get_note', { id });
  return r?.structuredContent ?? r;
}

async function mintAgentToken(env: Env, ownerToken: string, ownerPassword: string, write?: AgentWriteOpt): Promise<string> {
  const res = await app.request('/api/agent-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ label: 'files-test', password: ownerPassword, ...(write ? { write } : {}) }),
  }, env);
  if (res.status !== 201) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

const WRITE_ALL: AgentWriteOpt = { create: true, update: true, trash: true };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

describe('MCP file tools (POST /api/mcp tools/call)', () => {
  let env: Env;
  let raw: Database.Database;
  let store: Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string> }>;
  let ownerA: string;
  let passA: string;

  beforeEach(async () => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    const r2 = stubR2();
    store = r2.store;
    env = makeEnv(raw, r2.bucket);
    passA = 'files-owner-password';
    ({ token: ownerA } = await signupToken(env, 'files-owner', passA));
  });

  // --- happy path -----------------------------------------------------------------------------------

  it('create_file_note mints a file-note: fileType marker + one attachment block, and the blob is stored', async () => {
    const token = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const r = await call(env, token, 'create_file_note', {
      filename: 'photo.png', mime: 'image/png', content_base64: b64(bytes(1024)),
    });
    expect(r.structuredContent.status).toBe('applied');
    const id = r.structuredContent.note.id;
    const note = await getNote(env, token, id);

    expect(note.title).toBe('photo.png');
    expect(note.properties.fileType).toEqual({ type: 'text', value: 'file' }); // the file-note discriminator
    expect(note.body).toHaveLength(1);
    expect(note.body[0].type).toBe('attachment');
    expect(note.body[0].content.name).toBe('photo.png');
    expect(note.body[0].content.mime).toBe('image/png');
    expect(note.body[0].content.size).toBe(1024);
    expect(note.body[0].content.hash).toMatch(/^[0-9a-f]{64}$/);
    // The bytes actually landed in R2 under the server-derived {accountId}/{hash} key (accountId prefix +
    // the block's content hash — never a client-steered key).
    expect(store.size).toBe(1);
    const key = [...store.keys()][0]!;
    expect(key).toMatch(/^[^/]+\/[0-9a-f]{64}$/);
    expect(key.endsWith(`/${note.body[0].content.hash}`)).toBe(true);
  });

  it('embed_file appends an attachment block to an existing note (existing content untouched)', async () => {
    const token = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const created = await call(env, token, 'create_note', { title: 'Doc', text: 'intro paragraph' });
    const id = created.structuredContent.note.id;

    const r = await call(env, token, 'embed_file', {
      note_id: id, filename: 'report.pdf', mime: 'application/pdf', content_base64: b64(bytes(2048)),
    });
    expect(r.structuredContent.status).toBe('applied');
    const note = await getNote(env, token, id);
    expect(note.body).toHaveLength(2);                    // original paragraph + appended attachment
    expect(note.body[0].content.segments[0].text).toBe('intro paragraph');
    expect(note.body[1].type).toBe('attachment');
    expect(note.body[1].content.name).toBe('report.pdf');
    expect(note.body[1].content.mime).toBe('application/pdf');
    expect(store.size).toBe(1);
  });

  // --- schema-first boundary rejections -------------------------------------------------------------

  it('rejects an oversize payload (> 6 MB decoded) at the boundary → invalid params', async () => {
    const token = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const oversize = 'A'.repeat(8_400_000); // valid base64 → ~6.3 MB decoded, over the 6 MB cap
    const body = await callRaw(env, token, 'create_file_note', { filename: 'big.bin', mime: 'application/octet-stream', content_base64: oversize });
    expect(body.error?.code).toBe(-32602);
    expect(store.size).toBe(0); // nothing stored on a boundary rejection
  });

  it('rejects malformed base64 at the boundary → invalid params', async () => {
    const token = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const body = await callRaw(env, token, 'create_file_note', { filename: 'x.bin', mime: 'application/octet-stream', content_base64: 'not valid base64 %%%' });
    expect(body.error?.code).toBe(-32602);
    expect(store.size).toBe(0);
  });

  it('rejects a malformed / empty mime at the boundary → invalid params', async () => {
    const token = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const bad = await callRaw(env, token, 'create_file_note', { filename: 'x.bin', mime: 'notamediatype', content_base64: b64(bytes(16)) });
    expect(bad.error?.code).toBe(-32602);
    const empty = await callRaw(env, token, 'create_file_note', { filename: 'x.bin', mime: '', content_base64: b64(bytes(16)) });
    expect(empty.error?.code).toBe(-32602);
    expect(store.size).toBe(0);
  });

  // --- BOLA -----------------------------------------------------------------------------------------

  it('🚨 BOLA: account B cannot embed into account A\'s note (not found) AND stores no bytes for it', async () => {
    const aWrite = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const created = await call(env, aWrite, 'create_note', { title: 'A private', text: 'secret' });
    const id = created.structuredContent.note.id;
    expect(store.size).toBe(0); // create_note stores no blob

    const { token: ownerB } = await signupToken(env, 'owner-b', 'owner-b-password');
    const bWrite = await mintAgentToken(env, ownerB, 'owner-b-password', WRITE_ALL);
    const r = await call(env, bWrite, 'embed_file', {
      note_id: id, filename: 'evil.pdf', mime: 'application/pdf', content_base64: b64(bytes(64)),
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not found/i);
    // Ownership is checked BEFORE the upload, so B's bytes were never stored.
    expect(store.size).toBe(0);
    // A's note is untouched (still just its paragraph).
    const note = await getNote(env, aWrite, id);
    expect(note.body).toHaveLength(1);
    expect(note.body[0].type).toBe('paragraph');
  });

  // --- image vs non-image both store (render is client-side) ----------------------------------------

  it('both an image and a non-image file store — the block carries the mime, rendering is the client\'s job', async () => {
    const token = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const img = await call(env, token, 'create_file_note', { filename: 'a.png', mime: 'image/png', content_base64: b64(bytes(128, 1)) });
    const pdf = await call(env, token, 'create_file_note', { filename: 'b.pdf', mime: 'application/pdf', content_base64: b64(bytes(256, 2)) });
    const imgNote = await getNote(env, token, img.structuredContent.note.id);
    const pdfNote = await getNote(env, token, pdf.structuredContent.note.id);
    expect(imgNote.body[0].content.mime).toBe('image/png');
    expect(pdfNote.body[0].content.mime).toBe('application/pdf');
    expect(store.size).toBe(2); // distinct content → distinct hashes → two stored objects
  });

  // --- aggregation seam (surfaces for write, hidden for read-only) ----------------------------------

  it('the seam surfaces create_file_note + embed_file for a write token and HIDES them from read-only', async () => {
    const ro = await mintAgentToken(env, ownerA, passA);            // no write opt-in
    const rw = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const list = (t: string) => rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, t)
      .then((r) => r.json()).then((b: any) => (b.result.tools as Array<{ name: string }>).map((x) => x.name));
    const roNames = await list(ro);
    const rwNames = await list(rw);
    expect(roNames).not.toContain('create_file_note');
    expect(roNames).not.toContain('embed_file');
    expect(rwNames).toContain('create_file_note');
    expect(rwNames).toContain('embed_file');

    // ...and the write-scope initialize instructions teach the file tools (read-only never sees them).
    const instr = (t: string) => rpc(env, { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }, t)
      .then((r) => r.json()).then((b: any) => b.result.instructions as string);
    expect(await instr(rw)).toMatch(/create_file_note/);
    expect(await instr(ro)).not.toMatch(/create_file_note/);
  });
});
