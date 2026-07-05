import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  setFileType,
  buildAttachmentBlock,
  buildAttachmentContent,
  getExtract,
  type PropertyBag,
} from '@deltos/shared';
import type { DbAdapter } from '../src/db/schema.js';
import { insertNote, searchNotes } from '../src/db/mutate.js';
import { extractForNote, sweepExtractions, PDF_EXTRACT_MAX_BYTES } from '../src/extraction.js';
import type { Env } from '../src/env.js';

/**
 * FILE-CONTENT EXTRACTION pipeline (ROAD-0014). Harness mirrors search.fts.test.ts: better-sqlite3 (FTS5
 * compiled in) + the real migrations, with an in-memory R2 stub and stubbed Workers AI / unpdf (neither runs
 * under vitest). Exercises the whole worker path end-to-end through the real mutators + FTS wiring.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

// unpdf is dynamic-imported inside the PDF extractor — mock it (its serverless pdf.js doesn't run here).
const unpdf = vi.hoisted(() => ({ text: ['page one', 'page two needle'] as string[], throws: false }));
vi.mock('unpdf', () => ({
  extractText: async () => {
    if (unpdf.throws) throw new Error('parse failure');
    return { totalPages: unpdf.text.length, text: unpdf.text };
  },
}));

const migrations = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0006_account-sync-seq.sql', '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql',
  '0009_backfill-default-notebooks.sql', '0010_nullable-notebookid-all-notes.sql',
  '0011_drop-isdefault-notebooksyncseg-notes_pull.sql', '0012_custom-dictionary.sql',
  '0013_agent-token-label.sql', '0014_grant-family-link.sql', '0015_audit-log.sql', '0016_usage-counter.sql',
  '0017_oauth-provider.sql', '0018_fts5-note-search.sql', '0019_note-routing-guide.sql', '0020_grant-sets.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function sqliteAdapter(db: Database.Database): DbAdapter {
  return {
    async batch(stmts) {
      const results: { rowsWritten: number }[] = [];
      db.transaction(() => {
        for (const s of stmts) {
          const info = db.prepare(s.sql).run(...(s.params as Array<string | number | null>));
          results.push({ rowsWritten: info.changes });
        }
      })();
      return results;
    },
    async first<T>(sql: string, params: unknown[]) {
      return (db.prepare(sql).get(...(params as Array<string | number | null>)) ?? null) as T | null;
    },
    async all<T>(sql: string, params: unknown[]) {
      return db.prepare(sql).all(...(params as Array<string | number | null>)) as T[];
    },
  };
}

/** D1Database shim over better-sqlite3 (matches transcribe.routes.test — extraction builds its own adapter). */
function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      sql, _params: [] as unknown[],
      bind(...p: unknown[]) { stmt._params = p; return stmt; },
      async first<T>() { return (raw.prepare(sql).get(...(stmt._params as never[])) ?? null) as T | null; },
      async all<T>() { return { results: raw.prepare(sql).all(...(stmt._params as never[])) as T[] }; },
      async run() { const i = raw.prepare(sql).run(...(stmt._params as never[])); return { meta: { rows_written: i.changes } }; },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(prepared: Array<{ sql: string; _params: unknown[] }>) {
      return prepared.map((s) => { const i = raw.prepare(s.sql).run(...(s._params as never[])); return { meta: { rows_written: i.changes } }; });
    },
  } as unknown as D1Database;
}

/** In-memory R2 — get() returns { size, arrayBuffer }. `size` may be overridden (test the threshold cheaply). */
function stubR2() {
  const store = new Map<string, { bytes: Uint8Array; size: number }>();
  const bucket = {
    // Accepts Uint8Array (tests) or ArrayBuffer (bakeImageDerivatives writes with put(key, ArrayBuffer, opts)).
    put(key: string, bytes: Uint8Array | ArrayBuffer, size?: number) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
      store.set(key, { bytes: u8, size: typeof size === 'number' ? size : u8.byteLength });
    },
    async head(key: string) { return store.has(key) ? { size: store.get(key)!.size } : null; },
    async get(key: string) {
      const o = store.get(key);
      if (!o) return null;
      return { size: o.size, async arrayBuffer() { return o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength); } };
    },
  };
  return { bucket: bucket as unknown as R2Bucket & { put(k: string, b: Uint8Array | ArrayBuffer, s?: number): void }, store };
}

/** Stub Workers Images binding: input().transform().output() → a fixed webp payload (or a throwing bake). */
function stubImages(throws = false) {
  return {
    input() {
      return { transform() { return { async output() {
        if (throws) throw new Error('images transform unavailable');
        return { image() { return new Uint8Array([7, 7, 7]); } };
      } }; } };
    },
  } as unknown;
}

function stubAI(text = 'transcribed invoice total 42', throws = false) {
  return { run: vi.fn(async () => { if (throws) throw new Error('model unavailable'); return { response: text }; }) } as unknown as Ai;
}

const NOW = '2026-07-05T00:00:00.000Z';
const ACCT = 'acct-extract-1';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let raw: Database.Database;
let db: DbAdapter;

beforeEach(() => {
  raw = new Database(':memory:');
  for (const m of migrations) raw.exec(m);
  db = sqliteAdapter(raw);
  unpdf.text = ['page one', 'page two needle'];
  unpdf.throws = false;
});

async function makeFileNote(id: string, hash: string, mime: string, name: string, acct = ACCT): Promise<void> {
  const block = buildAttachmentBlock(buildAttachmentContent({ name, type: mime }, { hash, size: 100 }));
  await insertNote(
    db,
    { id: id as never, notebookId: null, baseVersion: 0, draft: { title: name, properties: setFileType({}) as never, body: [block] as never } },
    acct,
    NOW,
  );
}

function readExtract(id: string) {
  const row = raw.prepare('SELECT properties, version FROM notes WHERE id = ?').get(id) as { properties: string; version: number };
  return { extract: getExtract(JSON.parse(row.properties) as PropertyBag), version: row.version };
}

describe('extractForNote — PDF text-layer', () => {
  it('extracts per-page text, page-segmented, and feeds server FTS (extract-only content is findable)', async () => {
    const { bucket } = stubR2();
    bucket.put(`${ACCT}/hpdf`, new Uint8Array([1, 2, 3]));
    await makeFileNote(uuid(1), 'hpdf', 'application/pdf', 'doc.pdf');

    // Before extraction the body carries no searchable text (the attachment block is textless).
    expect(await searchNotes(db, undefined, ACCT, 'needle')).toHaveLength(0);

    await extractForNote({ DB: d1Over(raw), BLOBS: bucket } as unknown as Env, ACCT, uuid(1));

    const { extract, version } = readExtract(uuid(1));
    expect(extract?.method).toBe('pdf-text');
    expect(extract?.blobHash).toBe('hpdf');
    expect(extract?.truncated).toBe(false);
    expect(extract?.pages).toEqual([{ p: 1, t: 'page one' }, { p: 2, t: 'page two needle' }]);
    expect(version).toBe(2); // CAS bumped the note version so it flows to clients

    // The extract text is now in the FTS index → the PDF's inner content is searchable.
    expect((await searchNotes(db, undefined, ACCT, 'needle')).map((r) => r.id)).toEqual([uuid(1)]);
  });

  it('is idempotent: a second run is a no-op (version unchanged)', async () => {
    const { bucket } = stubR2();
    bucket.put(`${ACCT}/hpdf`, new Uint8Array([1]));
    await makeFileNote(uuid(2), 'hpdf', 'application/pdf', 'doc.pdf');
    const env = { DB: d1Over(raw), BLOBS: bucket } as unknown as Env;

    await extractForNote(env, ACCT, uuid(2));
    expect(readExtract(uuid(2)).version).toBe(2);
    await extractForNote(env, ACCT, uuid(2));
    expect(readExtract(uuid(2)).version).toBe(2); // no second write
  });

  it('a PDF over the size threshold is an honest empty+truncated skip (marked processed, not retried)', async () => {
    const { bucket } = stubR2();
    bucket.put(`${ACCT}/big`, new Uint8Array([1]), PDF_EXTRACT_MAX_BYTES + 1); // logical size over threshold
    await makeFileNote(uuid(3), 'big', 'application/pdf', 'big.pdf');

    await extractForNote({ DB: d1Over(raw), BLOBS: bucket } as unknown as Env, ACCT, uuid(3));
    const { extract } = readExtract(uuid(3));
    expect(extract).toMatchObject({ method: 'pdf-text', blobHash: 'big', truncated: true, pages: [] });
  });

  it('a parse failure yields a FINAL empty extract (not retried)', async () => {
    unpdf.throws = true;
    const { bucket } = stubR2();
    bucket.put(`${ACCT}/corrupt`, new Uint8Array([1]));
    await makeFileNote(uuid(4), 'corrupt', 'application/pdf', 'x.pdf');

    await extractForNote({ DB: d1Over(raw), BLOBS: bucket } as unknown as Env, ACCT, uuid(4));
    expect(readExtract(uuid(4)).extract).toMatchObject({ method: 'pdf-text', truncated: false, pages: [] });
  });

  it('bytes not yet in R2 → RETRY (no extract written, so the cron re-attempts)', async () => {
    const { bucket } = stubR2(); // no blob put
    await makeFileNote(uuid(5), 'missing', 'application/pdf', 'x.pdf');
    await extractForNote({ DB: d1Over(raw), BLOBS: bucket } as unknown as Env, ACCT, uuid(5));
    expect(readExtract(uuid(5)).extract).toBeNull();
  });

  it('truncates at page boundaries when the total exceeds the budget', async () => {
    unpdf.text = ['A'.repeat(20000), 'B'.repeat(20000), 'C'.repeat(20000)];
    const { bucket } = stubR2();
    bucket.put(`${ACCT}/hpdf`, new Uint8Array([1]));
    await makeFileNote(uuid(6), 'hpdf', 'application/pdf', 'doc.pdf');
    await extractForNote({ DB: d1Over(raw), BLOBS: bucket } as unknown as Env, ACCT, uuid(6));
    const { extract } = readExtract(uuid(6));
    expect(extract?.truncated).toBe(true);
    const total = extract!.pages.reduce((n, p) => n + p.t.length, 0);
    expect(total).toBeLessThanOrEqual(32 * 1024);
    expect(extract!.pages[0]!.p).toBe(1); // page numbers preserved
  });
});

describe('extractForNote — image OCR', () => {
  it('OCRs the .view.webp derivative → single null-page extract, searchable via FTS', async () => {
    const { bucket } = stubR2();
    bucket.put(`${ACCT}/himg.view.webp`, new Uint8Array([9, 9]));
    await makeFileNote(uuid(10), 'himg', 'image/png', 'photo.png');

    await extractForNote({ DB: d1Over(raw), BLOBS: bucket, AI: stubAI('transcribed invoice needle') } as unknown as Env, ACCT, uuid(10));
    const { extract } = readExtract(uuid(10));
    expect(extract?.method).toBe('ocr');
    expect(extract?.pages).toEqual([{ p: null, t: 'transcribed invoice needle' }]);
    expect((await searchNotes(db, undefined, ACCT, 'needle')).map((r) => r.id)).toEqual([uuid(10)]);
  });

  it('no derivative AND no original → empty FINAL extract (nothing to OCR, ever)', async () => {
    const { bucket } = stubR2(); // no view.webp, no original
    await makeFileNote(uuid(11), 'noderiv', 'image/heic', 'photo.heic');
    await extractForNote({ DB: d1Over(raw), BLOBS: bucket, AI: stubAI() } as unknown as Env, ACCT, uuid(11));
    expect(readExtract(uuid(11)).extract).toMatchObject({ method: 'ocr', pages: [] });
  });

  it('a missing derivative SELF-HEALS: re-bakes from the original, then OCRs it', async () => {
    const { bucket } = stubR2();
    bucket.put(`${ACCT}/healme`, new Uint8Array([1, 2, 3])); // original present, NO view.webp (transient bake miss)
    await makeFileNote(uuid(15), 'healme', 'image/png', 'heal.png');
    const env = { DB: d1Over(raw), BLOBS: bucket, AI: stubAI('healed needle text'), IMAGES: stubImages() } as unknown as Env;
    await extractForNote(env, ACCT, uuid(15));
    expect(readExtract(uuid(15)).extract).toMatchObject({ method: 'ocr', pages: [{ p: null, t: 'healed needle text' }] });
    expect(await (bucket as unknown as R2Bucket).head(`${ACCT}/healme.view.webp`)).not.toBeNull(); // bake landed
  });

  it('a missing derivative whose re-bake still fails is RETRYABLE (no extract written)', async () => {
    const { bucket } = stubR2();
    bucket.put(`${ACCT}/stuckbake`, new Uint8Array([1, 2, 3])); // original present, bake keeps failing
    await makeFileNote(uuid(16), 'stuckbake', 'image/png', 'stuck.png');
    const env = { DB: d1Over(raw), BLOBS: bucket, AI: stubAI(), IMAGES: stubImages(true) } as unknown as Env;
    await extractForNote(env, ACCT, uuid(16));
    expect(readExtract(uuid(16)).extract).toBeNull();
  });

  it('an empty successful transcription is FINAL (image has no text)', async () => {
    const { bucket } = stubR2();
    bucket.put(`${ACCT}/blank.view.webp`, new Uint8Array([1]));
    await makeFileNote(uuid(12), 'blank', 'image/jpeg', 'blank.jpg');
    await extractForNote({ DB: d1Over(raw), BLOBS: bucket, AI: stubAI('') } as unknown as Env, ACCT, uuid(12));
    expect(readExtract(uuid(12)).extract).toMatchObject({ method: 'ocr', pages: [] });
  });

  it('a model error is RETRYABLE (no extract written)', async () => {
    const { bucket } = stubR2();
    bucket.put(`${ACCT}/err.view.webp`, new Uint8Array([1]));
    await makeFileNote(uuid(13), 'err', 'image/png', 'x.png');
    await extractForNote({ DB: d1Over(raw), BLOBS: bucket, AI: stubAI('', true) } as unknown as Env, ACCT, uuid(13));
    expect(readExtract(uuid(13)).extract).toBeNull();
  });
});

describe('sweepExtractions — bounded backfill', () => {
  it('processes at most the per-run budget, is resumable, and skips non-extractable file notes', async () => {
    const { bucket } = stubR2();
    // 22 extractable PDF file notes (each with its blob) + 1 non-extractable (.blend, no blob needed).
    for (let i = 0; i < 22; i++) {
      bucket.put(`${ACCT}/h${i}`, new Uint8Array([1]));
      await makeFileNote(uuid(100 + i), `h${i}`, 'application/pdf', `doc${i}.pdf`);
    }
    await makeFileNote(uuid(200), 'blend', 'application/octet-stream', 'model.blend');
    const env = { DB: d1Over(raw), BLOBS: bucket } as unknown as Env;

    const countExtracted = () => raw.prepare(
      `SELECT COUNT(*) c FROM notes WHERE json_extract(properties,'$."sys:extract"') IS NOT NULL`,
    ).get() as { c: number };

    await sweepExtractions(env);
    expect(countExtracted().c).toBe(20); // capped at the per-run budget

    await sweepExtractions(env);
    expect(countExtracted().c).toBe(22); // remaining 2 picked up — resumable, oldest-first

    // The non-extractable .blend note never gets an extract (skipped, no budget spent, no hot-loop).
    const blend = raw.prepare('SELECT properties FROM notes WHERE id = ?').get(uuid(200)) as { properties: string };
    expect(getExtract(JSON.parse(blend.properties) as PropertyBag)).toBeNull();
  });
});
