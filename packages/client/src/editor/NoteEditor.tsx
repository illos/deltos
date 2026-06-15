import { useCallback, useEffect, useRef, useState } from 'react';
import type { Note, BlockBody } from '@deltos/shared';
import { ProseMirrorEditor } from './ProseMirrorEditor.js';

export interface NoteEditorProps {
  note: Note;
  onSave: (note: Note) => Promise<void>;
}

const TITLE_DEBOUNCE_MS = 400;

/**
 * The capture surface editor. Owns the title input and delegates the body to ProseMirrorEditor.
 *
 * Optimistic persistence: every change writes to the local Dexie store immediately (via onSave)
 * and flows into Stream B's syncQueue in the same transaction. No network round-trip on the
 * critical path — the note is visible and recoverable from IndexedDB before sync confirms it.
 *
 * PIN-MODEL-1 rail #3: when relation properties are displayed, titles are resolved at render
 * time through the can() check from the principal's local replica, never denormalized.
 * That rendering path is a Phase-1 D wiring concern; this editor only stores the note by id.
 */
export function NoteEditor({ note, onSave }: NoteEditorProps) {
  const [title, setTitle] = useState(note.title);
  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // If the note changes from outside (incoming sync update), re-sync the title input.
  useEffect(() => {
    setTitle(note.title);
  }, [note.id, note.title]);

  const persistUpdate = useCallback(
    (updates: Partial<Pick<Note, 'title' | 'body'>>) => {
      const now = new Date().toISOString();
      const updated: Note = {
        ...note,
        ...updates,
        updatedAt: now,
        syncStatus: 'pending',
      };
      // Fire-and-forget; the optimistic local write is the user-visible action.
      void onSave(updated);
    },
    [note, onSave],
  );

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setTitle(value);
    if (titleTimerRef.current !== null) clearTimeout(titleTimerRef.current);
    titleTimerRef.current = setTimeout(() => {
      titleTimerRef.current = null;
      persistUpdate({ title: value });
    }, TITLE_DEBOUNCE_MS);
  };

  const handleBodyChange = useCallback(
    (body: BlockBody) => {
      persistUpdate({ body });
    },
    [persistUpdate],
  );

  return (
    <div className="editor">
      <input
        className="editor__title"
        value={title}
        onChange={handleTitleChange}
        placeholder="Title"
      />
      <ProseMirrorEditor
        noteId={note.id}
        initialBody={note.body}
        onChange={handleBodyChange}
        autoFocus={title === ''}
      />
    </div>
  );
}
