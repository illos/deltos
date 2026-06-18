import { useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useNotebooks, useNotes } from '../db/storeHooks.js';
import { useNotebookStore } from '../lib/notebookStore.js';
import { mutateNotebooks } from '../db/mutateNotebooks.js';

/**
 * Landing screen when no current notebook is set, and the notebook management surface.
 *
 * Shows all live notebooks (sorted by name), with note counts; allows creating a new notebook.
 * Tapping a notebook sets it as current and causes AuthedShell to reactively switch to the shell.
 */
export function AllNotebooksScreen() {
  const notebooks = useNotebooks();
  const notes = useNotes();
  const setCurrentNotebook = useNotebookStore((s) => s.setCurrentNotebook);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const countByNotebook = useMemo(() => {
    const m: Record<string, number> = {};
    for (const n of notes) m[n.notebookId] = (m[n.notebookId] ?? 0) + 1;
    return m;
  }, [notes]);

  const handleCreate = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const id = await mutateNotebooks.create(trimmed);
    await setCurrentNotebook(id);
    setCreating(false);
    setNewName('');
  }, [newName, setCurrentNotebook]);

  return (
    <div className="all-notebooks">
      <ul className="all-notebooks__list">
        {notebooks.map((nb) => (
          <li key={nb.id}>
            <button
              className="all-notebooks__nb-btn"
              onClick={() => { void setCurrentNotebook(nb.id); }}
            >
              <span className="all-notebooks__nb-name">{nb.name}</span>
              {nb.isDefault && <span className="all-notebooks__nb-default"> ★</span>}
              <span className="all-notebooks__nb-count"> ({countByNotebook[nb.id] ?? 0})</span>
            </button>
          </li>
        ))}
      </ul>

      {creating ? (
        <form
          className="all-notebooks__new-form"
          onSubmit={(e) => { e.preventDefault(); void handleCreate(); }}
        >
          <input
            className="all-notebooks__new-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Notebook name"
            autoFocus
          />
          <button type="submit" className="all-notebooks__new-confirm">Create</button>
          <button type="button" className="all-notebooks__new-cancel" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
        </form>
      ) : (
        <button className="all-notebooks__new-btn" onClick={() => setCreating(true)}>＋ New notebook</button>
      )}

      <Link to="/trash" className="all-notebooks__trash-link">Trash</Link>
    </div>
  );
}
