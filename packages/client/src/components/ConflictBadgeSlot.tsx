/**
 * CONFLICT-BADGE MOUNT SLOT (per-note-row) — Part 2.
 * Reads note.hasConflict (ClientNote field landed in schema v4 @2991ed1) and renders
 * ConflictBadge. The list note type is Note from @deltos/shared; the runtime value from
 * dexieLocalStore is ClientNote (EntityTable<ClientNote, 'id'>), so the cast is safe.
 */
import { useNavigate } from 'react-router-dom';
import type { Note } from '@deltos/shared';
import type { ClientNote } from '../db/schema.js';
import { ConflictBadge } from './ConflictBadge.js';

export function ConflictBadgeSlot({ note }: { note: Note }) {
  const navigate = useNavigate();
  const clientNote = note as ClientNote;
  if (!clientNote.hasConflict) return null;
  return (
    <ConflictBadge onClick={() => navigate(`/note/${note.id}`)} />
  );
}
