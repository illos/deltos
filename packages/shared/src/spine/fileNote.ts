import type { Note } from './note.js';
import type { PropertyBag } from './property.js';

/**
 * File-note discriminator — the note-type sibling of the attachment BLOCK (file-notes.md §2).
 *
 * A file note is a plain {@link Note} whose `title` is the original filename, whose `body` is a
 * single attachment `plugin_block`, and whose `properties` carry a `fileType:'file'` MARKER. The
 * presence of that marker is the ONLY note-type discriminator; the actual file FORMAT (pdf / image
 * / `.blend` / …) is derived from the attachment block's `mime` / `name`, NEVER from this key.
 *
 * Single-source chokepoint, mirroring `isTrashed`/`setTrashedAt` in {@link ./reservedKeys}: the
 * HomeView list branch and the FileNoteView resolve predicate both import {@link isFileNote} so the
 * two reads can never drift. Distinct from the trash flag in one deliberate way — the `fileType`
 * key is in the USER namespace (no `sys:` prefix), so `userProperties()` does NOT strip it. That is
 * intentional: duplicating a file note preserves its file-note-ness, and the type round-trips as
 * ordinary metadata (file-notes.md §2.1).
 */

/** The marker value carried under the `fileType` key. A simple marker string, NOT the file's format. */
export const FILE_NOTE_TYPE = 'file' as const;

/** The property KEY that carries the file-note marker. User-namespace (no `sys:` prefix) on purpose. */
export const FILE_TYPE_KEY = 'fileType' as const;

/**
 * True iff `note` is a file note: its `fileType` property is a `text` value equal to the marker.
 * FAIL-SAFE — any other shape (key absent, wrong value type, wrong value) reads as a NORMAL note,
 * so a corrupt marker degrades to the ordinary editor rather than a broken viewer. THE single
 * definition both render surfaces (list branch + view resolve) share.
 */
export function isFileNote(note: Note): boolean {
  const v = note.properties[FILE_TYPE_KEY];
  return v?.type === 'text' && v.value === FILE_NOTE_TYPE;
}

/**
 * Return a NEW bag with the file-note marker SET (the `setTrashedAt` analogue, used by the creation
 * path). Pure — does not mutate the input. The key is deliberately user-namespace so it survives
 * `userProperties()` and thus duplication.
 */
export function setFileType(bag: PropertyBag): PropertyBag {
  return { ...bag, [FILE_TYPE_KEY]: { type: 'text', value: FILE_NOTE_TYPE } };
}
