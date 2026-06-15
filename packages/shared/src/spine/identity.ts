import { z } from 'zod';
import { NoteIdSchema, NotebookIdSchema, TimestampSchema } from './ids.js';

/**
 * Sync status is a client-side fact about a note's local copy relative to the server — it
 * lives on identity because every surface needs to show it, but the server never authors it.
 */
export const SYNC_STATUSES = ['synced', 'pending', 'failed', 'local-only'] as const;
export const SyncStatusSchema = z.enum(SYNC_STATUSES);
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

/**
 * Identity & metadata — the system-owned layer present on every note, fixed in shape. This
 * is what makes notes addressable; nothing here is user-authored except `title`.
 *
 * `version` is the integer counter that drives fork-on-conflict: a flush compares the local
 * version against the server's and forks to a copy only on an actual mismatch. There is no
 * last-write-wins anywhere in the substrate.
 */
export const NoteIdentitySchema = z.object({
  id: NoteIdSchema,
  notebookId: NotebookIdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  version: z.number().int().nonnegative(),
  syncStatus: SyncStatusSchema,
  title: z.string(),
});
export type NoteIdentity = z.infer<typeof NoteIdentitySchema>;
