/**
 * TrashRoute — minimal trash view. Lists trashed notes; each row has a Restore button.
 *
 * Restore calls mutateNotes.restore(note) → note leaves trash + re-enters the main list
 * via the reactive observeNotes filter. A brief "Restored" toast confirms the action.
 *
 * Deferred (not in scope): permanent-delete, empty-trash, bulk-select.
 *
 * The useTrashedNotes hook currently returns [] (stub). Wire when devSys2 ships
 * observeTrashedNotes — see storeHooks.ts comment.
 */
import { Link } from 'react-router-dom';
import { useTrashedNotes } from '../db/storeHooks.js';
import { mutateNotes } from '../db/mutate.js';
import { showToast } from '../lib/toastEvents.js';

export function TrashRoute() {
  const notes = useTrashedNotes();

  const handleRestore = (note: Parameters<typeof mutateNotes.restore>[0]) => {
    mutateNotes.restore(note).then(() => showToast(`"${note.title || 'Untitled'}" restored`)).catch(console.error);
  };

  return (
    <div className="trash">
      <div className="trash__header">
        <Link to="/" className="trash__back">← Notes</Link>
        <span className="trash__title">Trash</span>
      </div>

      {notes.length === 0 ? (
        <p className="trash__lede">Trash is empty.</p>
      ) : (
        <ul className="trash__notes">
          {notes.map(note => (
            <li key={note.id} className="trash__row">
              <span className="trash__note-title">{note.title || 'Untitled'}</span>
              <button
                className="trash__restore-btn"
                onClick={() => handleRestore(note)}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
