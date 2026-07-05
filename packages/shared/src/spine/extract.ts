import { z } from 'zod';
import { RESERVED_KEY_PREFIX } from './reservedKeys.js';
import { PropertyBagSchema, type PropertyBag } from './property.js';
import { ATTACHMENT_PLUGIN_TYPE, type AttachmentContent } from './attachmentBlock.js';
import { FILE_TYPE_KEY, FILE_NOTE_TYPE } from './fileNote.js';
import type { Block } from './block.js';

/**
 * FILE-CONTENT EXTRACT (ROAD-0014) — the invisible, synced metadata that makes a file note's INNER
 * content searchable. A digital PDF's text layer (per page) or an image's OCR transcription is pulled
 * server-side, capped, page-segmented, and attached to the file note under a reserved SYSTEM property
 * key so it:
 *   - rides the existing `upsert` sync path with NO wire/protocol change (like the Fork-P trash flag);
 *   - is hidden from every user-facing property surface + export (it lives under `sys:`, so
 *     {@link isReservedKey}/{@link userProperties} strip it for free — no per-key handling);
 *   - feeds BOTH search engines: the client fuzzy engine reads it on-device/offline (via {@link getExtract});
 *     the server FTS5 index derives its body text from it (via {@link extractPropsText}).
 *
 * FITTING THE PROPERTY BAG (schema-first): a property VALUE must be one of the {@link PropertyValueSchema}
 * variants. The extract is a structured object, so it is stored as a `text` property whose value is the
 * JSON-serialised {@link NoteExtract} — that passes sync-push `PropertyBagSchema` validation unchanged.
 * Readers ({@link getExtract}) parse + re-validate the JSON, FAIL-SAFE to null on any malformed shape.
 *
 * IDEMPOTENCY: {@link NoteExtract.blobHash} is the key — extraction is needed iff the note is a file note
 * with an extractable attachment AND (no extract yet OR the stored blobHash ≠ the attachment's current
 * hash). See {@link needsExtraction}. This makes the waitUntil trigger + the cron sweep converge without
 * re-processing, and lets a failing blob avoid a hot-loop (a written extract — even an empty one — marks
 * the note done).
 */

/** The reserved SYSTEM property key carrying the extract (JSON-encoded in a `text` value). */
export const SYS_EXTRACT_KEY = `${RESERVED_KEY_PREFIX}extract` as const;

/**
 * Total extracted-text budget across ALL pages, in characters (~32 KB). The tuning knob (perf north star):
 * the client fuzzy engine scans this on every keystroke, so it is capped and truncated at page boundaries
 * where possible. Raising it trades search cost for coverage.
 */
export const EXTRACT_TEXT_BUDGET = 32 * 1024;

/** One page (PDF) or the single image segment of an extract. `p` = 1-based PDF page; null for an image. */
export const ExtractPageSchema = z.object({
  p: z.number().int().positive().nullable(),
  t: z.string(),
});
export type ExtractPage = z.infer<typeof ExtractPageSchema>;

/**
 * The page-segmented extract stored under {@link SYS_EXTRACT_KEY}. `method` records HOW it was produced
 * (digital PDF text layer vs image OCR); `blobHash` is the idempotency key (= the attachment's hash at
 * extraction time); `truncated` is set when the {@link EXTRACT_TEXT_BUDGET} clipped the text (or a
 * >threshold PDF was skipped). An empty `pages` (or empty page text) is a VALID FINAL state — a scanned
 * image-only PDF, an image with no text, or an over-threshold PDF all legitimately extract to nothing.
 */
export const NoteExtractSchema = z.object({
  v: z.literal(1),
  method: z.enum(['pdf-text', 'ocr']),
  blobHash: z.string().min(1),
  extractedAt: z.string().min(1),
  truncated: z.boolean(),
  pages: z.array(ExtractPageSchema),
});
export type NoteExtract = z.infer<typeof NoteExtractSchema>;

/**
 * Read + validate the extract from a property bag. FAIL-SAFE: returns null when the key is absent, is not a
 * `text` value, does not parse as JSON, or fails the schema — so a corrupt extract simply means "no
 * searchable inner content", never a throw.
 */
export function getExtract(bag: PropertyBag): NoteExtract | null {
  const v = bag[SYS_EXTRACT_KEY];
  if (!v || v.type !== 'text') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v.value);
  } catch {
    return null;
  }
  const result = NoteExtractSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Return a NEW bag with the extract SET (JSON-encoded under {@link SYS_EXTRACT_KEY} as a `text` value).
 * Pure — does not mutate. The single sanctioned writer of the reserved extract key (the server extraction
 * pipeline), mirroring {@link setTrashedAt}'s discipline.
 */
export function setExtract(bag: PropertyBag, extract: NoteExtract): PropertyBag {
  return { ...bag, [SYS_EXTRACT_KEY]: { type: 'text', value: JSON.stringify(extract) } };
}

/** Flatten an extract's page text to one space-joined string (drops empty pages). */
export function extractFlatText(extract: NoteExtract): string {
  return extract.pages.map((pg) => pg.t).filter(Boolean).join(' ');
}

/**
 * The SERVER FTS derivation of a note's extract text, straight from the stored `properties` JSON string
 * (the authoritative read-back row). FAIL-SAFE to '' on any malformed input — the FTS body must never make
 * a mutation throw. Appended to the block-derived body text at upsert time (no sidecar table, no migration).
 */
export function extractPropsText(propsJson: string | null | undefined): string {
  if (!propsJson) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(propsJson);
  } catch {
    return '';
  }
  const bag = PropertyBagSchema.safeParse(parsed);
  if (!bag.success) return '';
  const extract = getExtract(bag.data);
  return extract ? extractFlatText(extract) : '';
}

// ---------------------------------------------------------------------------
// Eligibility predicate — shared by the sync-push trigger + the cron sweep + the worker extractor
// ---------------------------------------------------------------------------

/** The minimal parsed shape the extraction predicate reads (a NoteRow's parsed properties + body). */
export interface ExtractableNote {
  properties: PropertyBag;
  body: readonly Block[];
}

/** True iff the bag carries the file-note marker (bag-level mirror of {@link isFileNote}, FAIL-SAFE). */
function isFileNoteBag(bag: PropertyBag): boolean {
  const v = bag[FILE_TYPE_KEY];
  return v?.type === 'text' && v.value === FILE_NOTE_TYPE;
}

/**
 * Read the attachment payload from a (file-note) body — its single leading `attachment` block. FAIL-SAFE:
 * null if the body isn't a well-formed attachment block. Mirrors the client's `fileNoteAttachment` but
 * operates on a bare `Block[]` so the WORKER can call it over a parsed row without the client lib.
 */
export function attachmentContent(body: readonly Block[]): AttachmentContent | null {
  const block = body[0];
  if (!block || block.type !== ATTACHMENT_PLUGIN_TYPE) return null;
  const c = block.content as Partial<AttachmentContent> | null | undefined;
  if (!c || typeof c.hash !== 'string') return null;
  return {
    hash: c.hash,
    name: typeof c.name === 'string' ? c.name : '',
    mime: typeof c.mime === 'string' ? c.mime : '',
    size: typeof c.size === 'number' ? c.size : 0,
  };
}

/** The extractable KIND of a mime, or null when it is not extractable (never extracted, never retried). */
export function extractionKind(mime: string): 'pdf' | 'image' | null {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  return null;
}

/**
 * The extraction target for a note: its extractable attachment + kind, or null when the note is not a file
 * note, has no attachment, or the attachment's mime is not extractable. THE explicit eligibility gate — a
 * null here means "leave it alone forever" (no hot-loop for e.g. a `.blend` file note).
 */
export function extractionTarget(
  note: ExtractableNote,
): { attachment: AttachmentContent; kind: 'pdf' | 'image' } | null {
  if (!isFileNoteBag(note.properties)) return null;
  const attachment = attachmentContent(note.body);
  if (!attachment) return null;
  const kind = extractionKind(attachment.mime);
  if (!kind) return null;
  return { attachment, kind };
}

/**
 * Does this note need (re)extraction? True iff it has an extractable target AND either no extract yet OR the
 * stored extract's blobHash differs from the attachment's current hash. The single predicate the trigger,
 * the sweep, and the extractor all share so they converge idempotently.
 */
export function needsExtraction(note: ExtractableNote): boolean {
  const target = extractionTarget(note);
  if (!target) return false;
  const existing = getExtract(note.properties);
  return existing === null || existing.blobHash !== target.attachment.hash;
}

// ---------------------------------------------------------------------------
// Budget packing — truncate page text to the total budget at page boundaries where possible
// ---------------------------------------------------------------------------

/**
 * Pack raw per-page text into the {@link EXTRACT_TEXT_BUDGET}, preferring WHOLE pages: include pages in
 * order until the budget is spent; the page that would overflow is clipped to the remaining budget (a
 * single page can itself exceed the budget), and any page beyond it is dropped. Returns the packed pages +
 * whether anything was clipped/dropped (`truncated`). Empty pages are preserved (they still map a PDF page
 * number) but contribute no text.
 */
export function packExtractPages(
  raw: readonly ExtractPage[],
  budget: number = EXTRACT_TEXT_BUDGET,
): { pages: ExtractPage[]; truncated: boolean } {
  const pages: ExtractPage[] = [];
  let remaining = budget;
  let truncated = false;
  for (const page of raw) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (page.t.length <= remaining) {
      pages.push(page);
      remaining -= page.t.length;
    } else {
      pages.push({ p: page.p, t: page.t.slice(0, remaining) });
      remaining = 0;
      truncated = true;
    }
  }
  return { pages, truncated };
}
