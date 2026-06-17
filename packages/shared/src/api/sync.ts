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
 * The mutation intent of a queued write (swipe-delete / undo extension). `'upsert'` is the historical
 * behavior; `'delete'` and `'restore'` carry the soft-delete + undo signal the push path previously
 * could NOT express (the draft alone has no `deletedAt`, and the worker push handler only ever
 * inserted/updated — so a client soft-delete never reached the server and the note resurrected on the
 * next pull). `'restore'` is the SA-T6 matrix branch (the earlier "resurrect" phrasing in the kickoff
 * relay was superseded; client + worker + matrix all use the literal `'restore'`).
 *
 * DEFAULTS to `'upsert'` so it is fully backward-compatible: a pre-extension client omits the field and
 * every existing entry parses as an upsert — no migration, no break to in-flight queues.
 */
export const SyncPushOpSchema = z.enum(['upsert', 'delete', 'restore']);
export type SyncPushOp = z.infer<typeof SyncPushOpSchema>;

/**
 * One queued write to push. `baseVersion` is the CAS precondition:
 *   0  = new note (server will INSERT; conflicts if the id already exists)
 *   N  = update at this version (server will CAS on version = N; conflicts if moved)
 *
 * `op` selects the worker branch: `'upsert'` → insert/update (base 0 → INSERT, else CAS UPDATE);
 * `'delete'` → CAS soft-delete (sets `deletedAt`, WHERE keeps `deletedAt IS NULL` — only a live row);
 * `'restore'` → CAS un-delete (clears `deletedAt`, WHERE drops the `deletedAt IS NULL` guard since the
 * target row IS tombstoned, relying on the version CAS alone). All branches are account-scoped server-side.
 */
export const SyncPushEntrySchema = z.object({
  id: NoteIdSchema,
  draft: NoteDraftSchema.omit({ id: true, notebookId: true }),
  baseVersion: VersionSchema,
  op: SyncPushOpSchema.default('upsert'),
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
 * Pull request. `cursor = 0` triggers a full notebook sync.
 * The server returns notes with `syncSeq > cursor`, ordered ascending.
 */
export const SyncPullRequestSchema = z.object({
  notebookId: NotebookIdSchema,
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
