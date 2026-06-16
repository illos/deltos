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
 * The integer counter that drives fork-on-conflict (no last-write-wins anywhere in the
 * substrate). It is also the optimistic-concurrency precondition for every mutation: a write
 * carries the version it believes it is editing, and the server commits via a single atomic
 * compare-and-swap on `(id, notebookId, version)`, forking to a copy only on an actual
 * mismatch. Factored out so the REST mutation requests reuse the exact same shape.
 */
export const VersionSchema = z.number().int().nonnegative();
export type Version = z.infer<typeof VersionSchema>;

/**
 * Version convention, aligned with the S2 sync model:
 *  - `UNSYNCED_VERSION` (0): a note authored locally that has never round-tripped to the server.
 *  - `FIRST_SERVER_VERSION` (1): the server assigns this on the first successful create/flush,
 *    and increments by one on each subsequent committed mutation.
 */
export const UNSYNCED_VERSION = 0;
export const FIRST_SERVER_VERSION = 1;

/**
 * Identity & metadata — the system-owned layer present on every note, fixed in shape. This
 * is what makes notes addressable; nothing here is user-authored except `title`.
 */
export const NoteIdentitySchema = z.object({
  id: NoteIdSchema,
  notebookId: NotebookIdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  version: VersionSchema,
  syncStatus: SyncStatusSchema,
  title: z.string(),
  /** Client-side account scope: `base64url(SHA-256(signingPublicKey))` from the authed Identity. */
  accountFingerprint: z.string().optional(),
});
export type NoteIdentity = z.infer<typeof NoteIdentitySchema>;
