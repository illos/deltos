import { useCallback } from 'react';
import type { Note, BlockBody } from '@deltos/shared';
import { ProseMirrorEditor } from './ProseMirrorEditor.js';
import { formatSmartDate } from '../lib/notePreview.js';

export interface NoteEditorProps {
  note: Note;
  onSave: (note: Note) => Promise<void>;
  /** Focus the editor on mount — set only for newly-created notes. */
  autoFocus?: boolean;
}

/**
 * The capture surface editor. Delegates everything — title and body — to a single
 * ProseMirrorEditor instance. The PM document is structured as `title block*`, so the
 * title lives as the first node inside the same contenteditable. This means:
 *   - Enter at the end of the title drops into the first body paragraph naturally.
 *   - Drag-select spanning title + body works in one gesture.
 *   - No web-form feeling from a separate <input>.
 *
 * Optimistic persistence: every change writes to the local Dexie store immediately
 * (via onSave) and flows into Stream B's syncQueue in the same transaction. No network
 * round-trip on the critical path.
 */
export function NoteEditor({ note, onSave, autoFocus = false }: NoteEditorProps) {
  const persistUpdate = useCallback(
    (updates: Partial<Pick<Note, 'title' | 'body'>>) => {
      const now = new Date().toISOString();
      const updated: Note = {
        ...note,
        ...updates,
        updatedAt: now,
        syncStatus: 'pending',
      };
      void onSave(updated);
    },
    [note, onSave],
  );

  const handleDocChange = useCallback(
    (title: string, body: BlockBody) => {
      persistUpdate({ title, body });
    },
    [persistUpdate],
  );

  return (
    <div className="editor">
      <ProseMirrorEditor
        noteId={note.id}
        initialTitle={note.title}
        initialBody={note.body}
        onChange={handleDocChange}
        autoFocus={autoFocus}
        editedLabel={`Edited ${formatSmartDate(note.updatedAt)}`}
      />
    </div>
  );
}
