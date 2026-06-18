import { z } from 'zod';
import { NoteIdSchema, NotebookIdSchema, TimestampSchema } from '../spine/ids.js';
import { VersionSchema } from '../spine/identity.js';
import { NoteDraftSchema } from '../spine/note.js';
import { NoteResponseSchema } from './operations.js';

/**
 * Sync protocol schemas — the internal client↔server contract for the offline-first
 * write buffer (push) and server-authoritative pull stream (PIN-SYNC-1/2/3/4).
 *
 * These are separate from the REST operation schemas because sync is a substrate protocol,
 * not a user-facing CRUD operation. Both sides build against exactly these shapes.
 */

// ---------------------------------------------------------------------------
// Push — client flushes its offline write buffer
// ---------------------------------------------------------------------------

/**
 * One queued write to push. `baseVersion` is the CAS precondition:
 *   0  = new note (server will INSERT; conflicts if the id already exists)
 *   N  = update at this version (server will CAS on version = N; conflicts if moved)
 *
 * Note: swipe-delete/undo (Fork P) needs NO wire signal here — trash is a `sys:trashedAt` flag in the
 * note's property bag, so it rides a normal content upsert. (An `op` discriminator was briefly added for
 * the abandoned deletedAt-tombstone approach, then removed when Fork P was chosen.)
 */
export const SyncPushEntrySchema = z.object({
  id: NoteIdSchema,
  draft: NoteDraftSchema.omit({ id: true, notebookId: true }),
  baseVersion: VersionSchema,
});
export type SyncPushEntry = z.infer<typeof SyncPushEntrySchema>;

export const SyncPushRequestSchema = z.object({
  notebookId: NotebookIdSchema,
  entries: z.array(SyncPushEntrySchema).min(1).max(100),
});
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

/**
 * Per-entry result. `accepted` = the CAS committed; `conflict` = the server row moved (or
 * was deleted) under us — the full server state is returned so the client can fork.
 */
export const SyncPushResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    id: NoteIdSchema,
    outcome: z.literal('accepted'),
    version: VersionSchema,
    syncSeq: z.number().int().positive(),
  }),
  z.object({
    id: NoteIdSchema,
    outcome: z.literal('conflict'),
    /** Full current server state — null when the note was deleted (tombstone conflict). */
    serverNote: NoteResponseSchema.nullable(),
  }),
]);
export type SyncPushResult = z.infer<typeof SyncPushResultSchema>;

export const SyncPushResponseSchema = z.object({
  results: z.array(SyncPushResultSchema),
});
export type SyncPushResponse = z.infer<typeof SyncPushResponseSchema>;

// ---------------------------------------------------------------------------
// Pull — client fetches server updates since its last cursor
// ---------------------------------------------------------------------------

/**
 * A server note in the pull stream. Extends the core NoteResponse with `deletedAt`
 * (tombstone marker) so the client can apply PIN-SYNC-3 (delete-vs-edit resurrection)
 * and clear locally-deleted notes.
 */
export const SyncNoteSchema = NoteResponseSchema.extend({
  deletedAt: TimestampSchema.nullable(),
  syncSeq: z.number().int().nonnegative(),
});
export type SyncNote = z.infer<typeof SyncNoteSchema>;

/**
 * Pull request. The sync boundary is the ACCOUNT (Option B, 2026-06-18): the server scopes the
 * pull stream to the caller's accountId (derived from the bearer token), NOT to a notebookId — so
 * a notebookId is neither sent nor trusted here. `cursor` is the caller's per-ACCOUNT stream
 * position (was per-notebook pre-Fix-A); `cursor = 0` triggers a full account sync. The server
 * returns every note the account owns (across all notebookIds) with `syncSeq > cursor`, ordered
 * ascending — each carrying its own organizing notebookId.
 */
export const SyncPullRequestSchema = z.object({
  cursor: z.number().int().nonnegative(),
});
export type SyncPullRequest = z.infer<typeof SyncPullRequestSchema>;

export const SyncPullResponseSchema = z.object({
  notes: z.array(SyncNoteSchema),
  /** The highest syncSeq in this batch; use as the cursor for the next pull. */
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type SyncPullResponse = z.infer<typeof SyncPullResponseSchema>;
