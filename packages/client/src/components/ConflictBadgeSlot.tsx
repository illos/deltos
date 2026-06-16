import type { Note } from '@deltos/shared';

/**
 * CONFLICT-BADGE MOUNT SLOT (per-note-row) — Part 2 coordination point (pilot-reserved).
 *
 * Placeholder for gruntSys2's persistent conflict badge (acceptance row CAV-8). The badge shows on a
 * note row while the note has an unresolved conflict version attached. Per devSys2's data-model
 * contract (docs/design/part2-conflict-version-data-model.md, §1) the flag is `Note.hasConflict`
 * (reactive, like `syncStatus`) — but that field is NOT yet on the shared `Note` type, so this slot
 * deliberately does NOT read it: it takes the row's `note` and renders nothing.
 *
 * gruntSys2 (once `hasConflict` lands on NoteSchema): render the real ConflictBadge here, e.g.
 * `if (!note.hasConflict) return null; return <ConflictBadge … />`. The list already maps notes and
 * mounts this per row, so the wire-up is reading one extra boolean — no shell change.
 */
export function ConflictBadgeSlot(_props: { note: Note }) {
  return null;
}
