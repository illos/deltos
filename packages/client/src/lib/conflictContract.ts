/**
 * Conflict UX entry point — re-exports devSys2's conflict surface (src/db/conflict.ts).
 *
 * All conflict UX (ConflictView, ConflictBadge, NoteRoute) import from here; if the
 * import path for the real implementation changes, update this file only.
 */
export type { NoteVersion, ConflictResolution } from '../db/conflict.js';
export { useNoteVersions, resolveConflict } from '../db/conflict.js';
