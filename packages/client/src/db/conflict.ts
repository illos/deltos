import { useEffect, useState } from 'react';
import type { NoteId } from '@deltos/shared';
import { getStore } from './store.js';
import { useAuthStore } from '../auth/store.js';
import type { ConflictResolution } from './localStore.js';
import type { NoteVersion } from './schema.js';

/**
 * The conflict-as-version UX surface (Part 2). The ONE import path for the conflict UI: the reactive
 * version list + the resolve action. accountId comes from the session principal (useAuthStore), never
 * a body — the persistence layer stays auth-free and the reads/writes are client-side D6-scoped.
 * The badge reads `useNote(id).hasConflict` (already reactive); no hook needed for it here.
 */

export type { NoteVersion, ConflictResolution };

/** Reactive list of a note's retained conflict versions, scoped to the current session account. */
export function useNoteVersions(noteId: NoteId): NoteVersion[] {
  const accountId = useAuthStore((s) => s.accountId);
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  useEffect(() => {
    if (!accountId) {
      setVersions([]);
      return;
    }
    return getStore().observeNoteVersions(noteId, accountId, setVersions);
  }, [noteId, accountId]);
  return versions;
}

/**
 * Resolve a note's conflict — keep-mine / keep-theirs / keep-both. accountId is read from the session
 * principal (never passed in by a caller/body); throws fail-closed if there is no authed session.
 */
export async function resolveConflict(noteId: NoteId, resolution: ConflictResolution): Promise<void> {
  const accountId = useAuthStore.getState().accountId;
  if (!accountId) throw new Error('resolveConflict: no session accountId (must be unlocked + authed)');
  await getStore().resolveConflict(noteId, resolution, accountId);
}
