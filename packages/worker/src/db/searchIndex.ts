import { bodyJsonToPlainText, extractPropsText } from '@deltos/shared';
import type { DbAdapter, NoteRow } from './schema.js';

/**
 * FTS5 index maintenance for `notesFts` (migration 0018). Standalone FTS5 table; isolation/liveness/trash
 * live on `notes`, so this module only keeps the TEXT (title + body-plaintext) current per noteId.
 *
 * Every call runs AFTER the note CAS has already succeeded — the caller guards each invocation with the
 * same rows-written / success check that gates the note write, so a CAS MISS never touches the index
 * (indexing a write that didn't happen would surface a phantom result). It is a SEPARATE batch after the
 * note transaction because we can only index on success and the read-back row is only known then; the
 * design is intentionally eventual-consistent (searchNotes re-derives account/liveness/trash from `notes`
 * on every read, so a briefly-stale FTS row can never leak or mis-scope — at worst a just-saved note is
 * momentarily unfindable by body text).
 *
 * Text is derived from the AUTHORITATIVE read-back row (`row.title` / `row.body` — the values each
 * mutator re-SELECTs after its write), NOT from the incoming patch. That makes partial patches correct
 * for free: whatever the row now holds is what gets indexed.
 */

/**
 * Replace the note's FTS row (delete-then-insert) with fresh title + body-plaintext.
 *
 * ROAD-0014: the indexed body = the block-derived plaintext PLUS a file note's `sys:extract` page text
 * (digital-PDF text layer / image OCR), derived at upsert time from the authoritative row's `properties`
 * JSON — no sidecar table, no migration. So a note whose ONLY searchable content is inside its file (e.g.
 * a PDF's text) becomes findable by the server FTS engine the moment the extract write-back re-indexes it.
 */
export async function upsertNoteFts(db: DbAdapter, row: NoteRow): Promise<void> {
  const blockText = bodyJsonToPlainText(row.body);
  const extractText = extractPropsText(row.properties);
  const body = extractText ? `${blockText} ${extractText}` : blockText;
  await db.batch([
    { sql: `DELETE FROM notesFts WHERE noteId = ?`, params: [row.id] },
    {
      sql: `INSERT INTO notesFts (title, body, noteId) VALUES (?, ?, ?)`,
      params: [row.title ?? '', body, row.id],
    },
  ]);
}

/** Remove the note's FTS row (soft-delete / tombstone). Idempotent — a missing row is a no-op. */
export async function deleteNoteFts(db: DbAdapter, id: string): Promise<void> {
  await db.batch([{ sql: `DELETE FROM notesFts WHERE noteId = ?`, params: [id] }]);
}
