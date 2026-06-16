import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { UNSYNCED_VERSION } from '@deltos/shared';
import type { Note } from '@deltos/shared';
import { mutateNotes } from '../db/mutate.js';
import { newNoteId } from '../lib/ids.js';
import { getDefaultNotebookId } from '../lib/notebooks.js';
import { useAuthStore } from '../auth/store.js';

/**
 * The instant-capture route. On mount: mints a client UUID, writes the empty note to the
 * local store (atomic: note + syncQueue entry in one transaction), then navigates to the
 * editor. The note exists locally before the network is touched.
 *
 * The ref guard is required because React 18+ StrictMode fires effects twice in development;
 * without it two notes would be created and the second navigation would shadow the first.
 */
export function NewNote() {
  const navigate = useNavigate();
  const didCreate = useRef(false);
  const identity = useAuthStore(s => s.identity);

  useEffect(() => {
    if (didCreate.current) return;
    didCreate.current = true;

    const now = new Date().toISOString();
    const note: Note = {
      id: newNoteId(),
      notebookId: getDefaultNotebookId(),
      createdAt: now,
      updatedAt: now,
      version: UNSYNCED_VERSION,
      syncStatus: 'local-only',
      title: '',
      properties: {},
      body: [],
      accountFingerprint: identity?.id,
    };

    mutateNotes.put(note).then(() => {
      navigate(`/note/${note.id}`, { replace: true });
    });
  }, [navigate, identity]);

  return <div className="route-loading" aria-label="Opening note…" />;
}
