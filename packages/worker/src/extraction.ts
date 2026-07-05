import {
  needsExtraction,
  extractionTarget,
  getExtract,
  setExtract,
  packExtractPages,
  EXTRACT_TEXT_BUDGET,
  type NoteExtract,
  type ExtractPage,
  type PropertyBag,
  type Block,
  type AttachmentContent,
} from '@deltos/shared';
import type { Env } from './env.js';
import { d1Adapter } from './db/schema.js';
import type { DbAdapter, NoteRow } from './db/schema.js';
import { BUMP_SEQ_SQL, READ_SEQ_SQL } from './db/mutate.js';
import { upsertNoteFts } from './db/searchIndex.js';

/**
 * FILE-CONTENT EXTRACTION pipeline (ROAD-0014) — the server-side worker half that turns a file note's INNER
 * content into searchable, page-segmented text and attaches it to the note as the invisible `sys:extract`
 * property (which then rides sync to clients + feeds server FTS).
 *
 * Two extractable kinds (the shared {@link extractionTarget} predicate gates eligibility):
 *   - DIGITAL PDF (mime application/pdf, ≤ {@link PDF_EXTRACT_MAX_BYTES}): per-page text-layer extraction via
 *     `unpdf` (Cloudflare's documented in-Worker pattern; serverless pdf.js). NO OCR — a scanned/image-only
 *     PDF legitimately extracts to nothing. A PDF over the threshold is a HONEST SKIP: an empty extract with
 *     `truncated:true` so it is marked processed (memory guard — Jim has 100+MB PDFs; 128MB Worker memory).
 *   - IMAGE (mime image/*): OCR of the pre-baked `{hash}.view.webp` DERIVATIVE (uniform input, sidesteps HEIC)
 *     via Workers AI {@link OCR_MODEL} with a strict verbatim-transcription prompt. A missing derivative → an
 *     empty (final) extract; a successful-but-empty transcription is FINAL; a model error is RETRYABLE.
 *
 * TRIGGER: `waitUntil` after a sync-push note upsert (see routes/sync.ts) + the daily cron sweep (index.ts)
 * that backfills existing uploads + catches missed waitUntils. Extraction NEVER fails or slows the push.
 *
 * IDEMPOTENCY / no hot-loop: keyed on (note, blobHash) via {@link needsExtraction}. A written extract — even
 * an empty one — marks the note done. Only a RETRYABLE failure leaves no extract, so the bounded cron batch
 * (not the push) re-attempts it. The OCR path is the only inference spend (personal scale, no new metering).
 */

/** PDF byte threshold: at/under → full per-page extract; over → honest empty+truncated skip (memory guard). */
export const PDF_EXTRACT_MAX_BYTES = 25 * 1024 * 1024;

/** The image-OCR model (ROAD-0014, added 2026-04; advertises OCR incl. handwriting). */
export const OCR_MODEL = '@cf/google/gemma-4-26b-a4b-it';

/** Strict verbatim-transcription prompt — output ONLY the transcribed text, nothing on an image with no text. */
export const OCR_PROMPT =
  'Transcribe ALL text visible in this image exactly as written. ' +
  'Output only the transcribed text. If there is no text, output nothing.';

/** Cap on the OCR model's output tokens (bounds inference spend + output size). */
const OCR_MAX_TOKENS = 1024;

/** CAS write-back retry budget (mirrors the MCP write-tool conflict-retry posture). */
const WRITEBACK_ATTEMPTS = 4;

type ExtractOutcome = { status: 'ok'; extract: NoteExtract } | { status: 'retry' };

/**
 * Extract (if needed) the file content for one note and write it back. Re-loads the authoritative row and
 * re-checks {@link needsExtraction} under a fresh read (a waitUntil may fire after another writer already
 * extracted, or after the note was edited/trashed). Any thrown error is swallowed by the caller's
 * `waitUntil`/try — extraction must never be load-bearing.
 */
export async function extractForNote(env: Env, accountId: string, noteId: string): Promise<void> {
  if (!env.BLOBS) return; // no blob store → nothing to read
  const db = d1Adapter(env.DB);

  const row = await db.first<NoteRow>(
    `SELECT * FROM notes WHERE id = ? AND accountId = ? AND deletedAt IS NULL`,
    [noteId, accountId],
  );
  if (!row) return;

  const parsed = parseRow(row);
  if (!parsed) return;
  if (!needsExtraction(parsed)) return; // already done / not eligible / superseded

  const target = extractionTarget(parsed);
  if (!target) return;

  const outcome =
    target.kind === 'pdf'
      ? await extractPdf(env, accountId, target.attachment)
      : await extractImage(env, accountId, target.attachment);

  if (outcome.status === 'retry') return; // leave no extract → the cron sweep re-attempts

  await writeBackExtract(db, accountId, noteId, outcome.extract);
}

/** Parse a row's JSON `properties` + `body` into the predicate shape. FAIL-SAFE null on malformed JSON. */
function parseRow(row: NoteRow): { properties: PropertyBag; body: Block[] } | null {
  try {
    const properties = JSON.parse(row.properties) as PropertyBag;
    const body = JSON.parse(row.body) as Block[];
    if (!properties || typeof properties !== 'object' || !Array.isArray(body)) return null;
    return { properties, body };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PDF — digital text-layer extraction (unpdf), page-segmented, budget-capped
// ---------------------------------------------------------------------------

async function extractPdf(
  env: Env,
  accountId: string,
  att: AttachmentContent,
): Promise<ExtractOutcome> {
  const now = new Date().toISOString();
  const obj = await env.BLOBS!.get(`${accountId}/${att.hash}`);
  // Bytes not (yet) in R2 — e.g. a direct-to-R2 upload whose confirm lagged the note push. RETRY via cron.
  if (!obj) return { status: 'retry' };

  // Over the memory threshold: honest skip. Record an empty, truncated extract so it is marked processed
  // (v1 does not stream >threshold PDFs) — never retried, never hot-looped.
  if (obj.size > PDF_EXTRACT_MAX_BYTES) {
    return {
      status: 'ok',
      extract: { v: 1, method: 'pdf-text', blobHash: att.hash, extractedAt: now, truncated: true, pages: [] },
    };
  }

  let perPage: string[];
  try {
    const buf = await obj.arrayBuffer();
    // Dynamic import so unpdf's serverless pdf.js only EVALUATES when a PDF is actually extracted (keeps the
    // cold-start cheap for the >99% of requests that never extract). unpdf accepts the raw bytes directly.
    const { extractText } = await import('unpdf');
    const result = await extractText(new Uint8Array(buf), { mergePages: false });
    perPage = result.text;
  } catch (err) {
    // A parse failure (corrupt / encrypted / unsupported) is treated as a FINAL empty extract, NOT a retry:
    // re-parsing would just re-fail and burn CPU. The empty result marks the note done (scanned-PDF-shaped).
    console.error(`extraction: unpdf parse failed for ${accountId}/${att.hash} (final empty)`, err);
    return {
      status: 'ok',
      extract: { v: 1, method: 'pdf-text', blobHash: att.hash, extractedAt: now, truncated: false, pages: [] },
    };
  }

  const raw: ExtractPage[] = perPage.map((t, i) => ({ p: i + 1, t: normalizeText(t) }));
  const { pages, truncated } = packExtractPages(raw, EXTRACT_TEXT_BUDGET);
  return {
    status: 'ok',
    extract: { v: 1, method: 'pdf-text', blobHash: att.hash, extractedAt: now, truncated, pages },
  };
}

// ---------------------------------------------------------------------------
// Image — OCR the pre-baked WebP derivative via Workers AI
// ---------------------------------------------------------------------------

async function extractImage(
  env: Env,
  accountId: string,
  att: AttachmentContent,
): Promise<ExtractOutcome> {
  const now = new Date().toISOString();
  const emptyFinal: NoteExtract = {
    v: 1, method: 'ocr', blobHash: att.hash, extractedAt: now, truncated: false, pages: [],
  };

  // OCR runs on the pre-baked `.view.webp` DERIVATIVE, never the original bytes (uniform input; sidesteps
  // HEIC, which no CF extraction path decodes). A MISSING derivative (IMAGES unbound at upload, a failed
  // bake, or e.g. a HEIC whose bake didn't land) → an empty FINAL extract, not a retry.
  const obj = await env.BLOBS!.get(`${accountId}/${att.hash}.view.webp`);
  if (!obj) return { status: 'ok', extract: emptyFinal };

  if (!env.AI) return { status: 'retry' }; // binding not wired here → let the cron retry when it is

  let text: string;
  try {
    const bytes = new Uint8Array(await obj.arrayBuffer());
    // `Ai.run`'s model/input types are a pinned literal union that may not carry this (2026-04) model, so we
    // call through a permissive signature. The unified image-to-text contract: bytes as a number[] + prompt.
    const run = env.AI.run as unknown as (model: string, input: unknown) => Promise<unknown>;
    const result = (await run(OCR_MODEL, {
      prompt: OCR_PROMPT,
      image: Array.from(bytes),
      max_tokens: OCR_MAX_TOKENS,
    })) as { response?: string; description?: string; text?: string };
    text = normalizeText(result.response ?? result.description ?? result.text ?? '');
  } catch (err) {
    // Model error / transient capacity → RETRYABLE (leave no extract; the cron sweep re-attempts).
    console.error(`extraction: OCR failed for ${accountId}/${att.hash} (retry)`, err);
    return { status: 'retry' };
  }

  // An empty successful transcription is FINAL (image genuinely has no text). Non-empty → single page, p:null.
  if (!text) return { status: 'ok', extract: emptyFinal };
  const { pages, truncated } = packExtractPages([{ p: null, t: text }], EXTRACT_TEXT_BUDGET);
  return {
    status: 'ok',
    extract: { v: 1, method: 'ocr', blobHash: att.hash, extractedAt: now, truncated, pages },
  };
}

/** Collapse runs of whitespace (incl. the newlines PDFs/OCR emit) to single spaces + trim. */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// CAS write-back — set ONLY sys:extract, bump syncSeq + version, re-index FTS
// ---------------------------------------------------------------------------

/**
 * Merge the extract into the note's properties via an atomic CAS on `version` (mirrors the MCP write-tool
 * update: read current → merge → UPDATE … WHERE version = read, retry on conflict). Bumps the per-account
 * `accountSyncSeq` (so it flows down to clients on their next pull) and re-indexes FTS from the fresh row.
 *
 * GOTCHA d1-rowswritten: a CAS HIT is `rowsWritten > 0` (real D1 counts index writes, so a 1-row UPDATE on
 * this multi-index table reports >1) — NEVER `=== 1`. Returns whether the extract was written.
 */
async function writeBackExtract(
  db: DbAdapter,
  accountId: string,
  noteId: string,
  extract: NoteExtract,
): Promise<boolean> {
  for (let attempt = 0; attempt < WRITEBACK_ATTEMPTS; attempt++) {
    const row = await db.first<NoteRow>(
      `SELECT * FROM notes WHERE id = ? AND accountId = ? AND deletedAt IS NULL`,
      [noteId, accountId],
    );
    if (!row) return false; // note gone / hard-deleted since we started

    const props = JSON.parse(row.properties) as PropertyBag;
    // Re-check idempotency under this fresh read: if another writer already landed this exact extract, stop.
    const existing = getExtract(props);
    if (existing && existing.blobHash === extract.blobHash) return true;

    const newProps = setExtract(props, extract);
    const now = new Date().toISOString();
    const batch = await db.batch([
      { sql: BUMP_SEQ_SQL, params: [accountId] },
      {
        sql: `
          UPDATE notes
          SET properties = ?,
              updatedAt  = ?,
              version    = version + 1,
              syncSeq    = (${READ_SEQ_SQL})
          WHERE id        = ?
            AND accountId = ?
            AND version   = ?
            AND deletedAt IS NULL
        `,
        params: [JSON.stringify(newProps), now, accountId, noteId, accountId, row.version],
      },
    ]);
    if (batch[1]!.rowsWritten > 0) {
      const fresh = await db.first<NoteRow>(`SELECT * FROM notes WHERE id = ?`, [noteId]);
      if (fresh) await upsertNoteFts(db, fresh);
      return true;
    }
    // CAS miss (concurrent edit bumped version) → retry with a fresh read.
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cron sweep / backfill — bounded batch of file notes needing extraction, oldest-first
// ---------------------------------------------------------------------------

/** How many file notes to inspect per sweep (cheap row reads; bounds the JS-side eligibility scan). */
const SWEEP_SCAN_LIMIT = 200;
/** How many actual extractions to perform per sweep (bounds inference/CPU spend per cron invocation). */
const SWEEP_EXTRACT_BUDGET = 20;

/**
 * Backfill sweep (daily cron): find live file notes with NO `sys:extract` yet, oldest-first, and extract a
 * bounded batch. Backfills Jim's existing uploads over days + catches any missed waitUntil. Non-extractable
 * file notes (e.g. `.blend`) are cheaply skipped in JS (they never consume the extract budget), so the sweep
 * always makes progress on real work. Resumable: processed notes gain a `sys:extract` and leave the scan set.
 */
export async function sweepExtractions(env: Env): Promise<void> {
  if (!env.BLOBS) return;
  const db = d1Adapter(env.DB);

  // SQL pre-filter: live file notes with no extract yet. The blobHash-mismatch case (a replaced attachment)
  // is handled by the waitUntil path — file-note attachments are immutable in practice — so "no sys:extract"
  // is the right, index-cheap backfill filter.
  const candidates = await db.all<{ id: string; accountId: string; properties: string; body: string }>(
    `SELECT id, accountId, properties, body FROM notes
      WHERE deletedAt IS NULL
        AND json_extract(properties, '$."fileType".value') = 'file'
        AND json_extract(properties, '$."sys:extract"') IS NULL
      ORDER BY createdAt ASC
      LIMIT ?`,
    [SWEEP_SCAN_LIMIT],
  );

  let budget = SWEEP_EXTRACT_BUDGET;
  for (const c of candidates) {
    if (budget <= 0) break;
    let properties: PropertyBag;
    let body: Block[];
    try {
      properties = JSON.parse(c.properties) as PropertyBag;
      body = JSON.parse(c.body) as Block[];
    } catch {
      continue;
    }
    if (!needsExtraction({ properties, body })) continue; // non-extractable / already done → no budget spent
    budget -= 1;
    try {
      await extractForNote(env, c.accountId, c.id);
    } catch (err) {
      console.error(`extraction sweep: failed for note ${c.id} (non-fatal)`, err);
    }
  }
}
