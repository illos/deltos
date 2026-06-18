import { z } from 'zod';
import { NoteIdSchema, NotebookIdSchema, TimestampSchema } from '../spine/ids.js';
import { VersionSchema } from '../spine/identity.js';
import { NoteDraftSchema } from '../spine/note.js';
import { NotebookSchema, NotebookDraftSchema } from '../spine/notebook.js';
import { NoteResponseSchema } from './operations.js';

/**
 * Sync protocol schemas — the internal client↔server contract for the offline-first
 * write buffer (push) and server-authoritative pull stream (PIN-SYNC-1/2/3/4).
 *
 * These are separate from the REST operation schemas because sync is a substrate protocol,
 * not a user-facing CRUD operation. Both sides build against exactly these shapes.
 *
 * BOUNDARY: every entity (note + notebook) is account-scoped — the server derives the accountId
 * from the bearer token and rides ONE per-account `syncSeq` stream (Option B,
 * [[sync-notebookid-per-device-regression]]). notebookId is a per-note organizing tag, NOT a sync
 * or security boundary; notebooks are a first-class synced entity in the SAME stream.
 */

// ---------------------------------------------------------------------------
// Push — client flushes its offline write buffer (notes AND notebooks)
// ---------------------------------------------------------------------------

/**
 * One queued NOTE write to push. `baseVersion` is the CAS precondition:
 *   0  = new note (server INSERTs; conflicts if the id already exists)
 *   N  = update at this version (server CAS on version = N; conflicts if moved)
 *
 * `notebookId` resolution (Notebooks task #16):
 *   - INSERT (baseVersion 0): the note's notebook = `entry.notebookId` if present, else the batch-level
 *     `SyncPushRequest.notebookId` (the "current notebook" default). One of the two is REQUIRED.
 *   - UPDATE (baseVersion N): the notebook is RESTAMPED to `entry.notebookId` ONLY when it is present —
 *     that is the explicit "move note between notebooks" signal. An ordinary edit OMITS `notebookId`
 *     and the note stays in its current notebook (never an accidental move). Restamp is server-stamped
 *     on the CAS path and isolation-safe (notebookId is an organizing tag, not a boundary).
 * Trash (Fork P) needs no wire signal — `sys:trashedAt` rides the property bag.
 */
export const SyncPushEntrySchema = z.object({
  id: NoteIdSchema,
  notebookId: NotebookIdSchema.optional(),
  draft: NoteDraftSchema.omit({ id: true, notebookId: true }),
  baseVersion: VersionSchema,
});
export type SyncPushEntry = z.infer<typeof SyncPushEntrySchema>;

/**
 * One queued NOTEBOOK write to push. `baseVersion`: 0 = create, N = mutate at version N.
 *  - `draft` present, `delete` absent → create (baseVersion 0) or rename/retitle (baseVersion N).
 *  - `delete: true` → tombstone the notebook; its live notes are moved to Trash server-side
 *    (`sys:trashedAt`). The default notebook (server-owned `isDefault`) CANNOT be deleted → conflict.
 * A client can never create/assert the default; `isDefault` is not part of the draft.
 */
export const NotebookPushEntrySchema = z
  .object({
    id: NotebookIdSchema,
    baseVersion: VersionSchema,
    draft: NotebookDraftSchema.optional(),
    delete: z.literal(true).optional(),
  })
  .refine((e) => e.delete === true || e.draft !== undefined, {
    message: 'a notebook entry must carry a draft (create/rename) or delete:true',
  });
export type NotebookPushEntry = z.infer<typeof NotebookPushEntrySchema>;

/**
 * Push request — notes and/or notebooks in one batch. `notebookId` is the OPTIONAL batch-level default
 * notebook for note INSERTS that omit their own `entry.notebookId` (the "current notebook"); it is never
 * applied to updates. At least one entry across the two arrays is required.
 */
export const SyncPushRequestSchema = z
  .object({
    notebookId: NotebookIdSchema.optional(),
    entries: z.array(SyncPushEntrySchema).max(100).default([]),
    notebookEntries: z.array(NotebookPushEntrySchema).max(100).default([]),
  })
  .refine((r) => r.entries.length + r.notebookEntries.length >= 1, {
    message: 'push must carry at least one note or notebook entry',
  });
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

/**
 * Per-NOTE result. `accepted` = the CAS committed; `conflict` = the server row moved (or was deleted)
 * under us — the full server state is returned so the client can fork.
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

/** Per-NOTEBOOK result. Mirrors the note result; conflict carries the current server notebook (or null). */
export const NotebookPushResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    id: NotebookIdSchema,
    outcome: z.literal('accepted'),
    version: VersionSchema,
    syncSeq: z.number().int().positive(),
  }),
  z.object({
    id: NotebookIdSchema,
    outcome: z.literal('conflict'),
    /** Current server notebook — null when it does not exist for this account. */
    serverNotebook: NotebookSchema.extend({ version: VersionSchema }).nullable(),
    /** Set when the conflict is because the target is the undeletable default (delete rejected). */
    reason: z.enum(['stale', 'default_undeletable']).optional(),
  }),
]);
export type NotebookPushResult = z.infer<typeof NotebookPushResultSchema>;

export const SyncPushResponseSchema = z.object({
  results: z.array(SyncPushResultSchema),
  notebookResults: z.array(NotebookPushResultSchema).default([]),
});
export type SyncPushResponse = z.infer<typeof SyncPushResponseSchema>;

// ---------------------------------------------------------------------------
// Pull — client fetches server updates since its last cursor (notes AND notebooks)
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
 * A server notebook in the pull stream. `deletedAt` is the tombstone (a deleted notebook is streamed
 * so the client can drop it locally + reconcile a dangling "current notebook" pointer).
 */
export const SyncNotebookSchema = NotebookSchema.extend({
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable(),
  syncSeq: z.number().int().nonnegative(),
});
export type SyncNotebook = z.infer<typeof SyncNotebookSchema>;

/**
 * Pull request. The sync boundary is the ACCOUNT (Option B, 2026-06-18): the server scopes the pull
 * stream to the caller's accountId (derived from the bearer token), NOT to a notebookId. `cursor` is
 * the caller's per-ACCOUNT stream position; `cursor = 0` triggers a full account sync. The server
 * returns every NOTE and NOTEBOOK the account owns with `syncSeq > cursor`, ordered ascending over the
 * unified stream.
 */
export const SyncPullRequestSchema = z.object({
  cursor: z.number().int().nonnegative(),
});
export type SyncPullRequest = z.infer<typeof SyncPullRequestSchema>;

export const SyncPullResponseSchema = z.object({
  notes: z.array(SyncNoteSchema),
  notebooks: z.array(SyncNotebookSchema).default([]),
  /** The highest syncSeq in this batch (across notes AND notebooks); use as the next pull cursor. */
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type SyncPullResponse = z.infer<typeof SyncPullResponseSchema>;
