import type { Note } from '@deltos/shared';

/**
 * Shared blank-check predicate — the ONE definition used by both:
 *   (a) putNoteAndEnqueue: skip push queue for newly-created blank notes (#32)
 *   (b) NoteRoute discard: only discard on unmount when note started as new+blank (B3)
 *
 * Has content = non-empty title OR non-empty body.
 * Title-only note = HAS CONTENT (first-class, standing ruling).
 * Truly blank = no title AND no body.
 */
export function noteHasContent(note: Pick<Note, 'title' | 'body'>): boolean {
  return note.title !== '' || note.body.length > 0;
}
