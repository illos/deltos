import { useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import type { NotebookId } from '@deltos/shared';
import { useNotebooks, useNotes } from '../db/storeHooks.js';
import { useNotebookStore } from '../lib/notebookStore.js';
import { mutateNotebooks } from '../db/mutateNotebooks.js';
import { notifyQueueWrite } from '../lib/syncEngine.js';

interface NavContentProps {
  /** Called after a navigation action (notebook select, trash link). Lets the drawer close itself. */
  onNavigate?: () => void;
}

/**
 * The single composable nav component. Renders in two containers:
 *   1. Inside DrawerNav (left pull-out drawer, mobile/tablet-portrait)
 *   2. Inside AllNotebooksScreen (full-screen cold-start fallback, no valid current notebook)
 *
 * Desktop multi-pane (nav pane | list | note) = LATER — the component is already extractable
 * as-is because it carries no container logic.
 */
export function NavContent({ onNavigate }: NavContentProps) {
  const notebooks = useNotebooks();
  const notes = useNotes();
  const currentNotebookId = useNotebookStore((s) => s.currentNotebookId);
  const setCurrentNotebook = useNotebookStore((s) => s.setCurrentNotebook);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const countByNotebook = useMemo(() => {
    const m: Record<string, number> = {};
    for (const n of notes) m[n.notebookId] = (m[n.notebookId] ?? 0) + 1;
    return m;
  }, [notes]);

  const handleSelect = useCallback(
    async (id: NotebookId) => {
      await setCurrentNotebook(id);
      onNavigate?.();
    },
    [setCurrentNotebook, onNavigate],
  );

  const handleCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = newName.trim();
      if (!trimmed) return;
      const id = await mutateNotebooks.create(trimmed);
      notifyQueueWrite(id);
      await setCurrentNotebook(id);
      setCreating(false);
      setNewName('');
      onNavigate?.();
    },
    [newName, setCurrentNotebook, onNavigate],
  );

  const cancelCreate = useCallback(() => {
    setCreating(false);
    setNewName('');
  }, []);

  return (
    <nav className="nav-content" aria-label="Notebooks">
      <ul className="nav-content__list">
        {notebooks.map((nb) => (
          <li
            key={nb.id}
            className={`nav-content__item${nb.id === currentNotebookId ? ' nav-content__item--current' : ''}`}
          >
            <button className="nav-content__nb-btn" onClick={() => { void handleSelect(nb.id); }}>
              <span className="nav-content__nb-name">{nb.name}</span>
              <span className="nav-content__nb-meta">
                {nb.isDefault && <span className="nav-content__nb-star" aria-label="Default">★</span>}
                <span className="nav-content__nb-count">{countByNotebook[nb.id] ?? 0}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {creating ? (
        <form className="nav-content__new-form" onSubmit={(e) => { void handleCreate(e); }}>
          <input
            className="nav-content__new-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Notebook name"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
          <div className="nav-content__new-actions">
            <button type="submit" className="nav-content__new-confirm">Create</button>
            <button type="button" className="nav-content__new-cancel" onClick={cancelCreate}>Cancel</button>
          </div>
        </form>
      ) : (
        <button className="nav-content__new-btn" onClick={() => setCreating(true)}>＋ New notebook</button>
      )}

      <div className="nav-content__footer">
        <Link to="/trash" className="nav-content__trash-link" onClick={onNavigate}>Trash</Link>
        <button className="nav-content__settings-btn" onClick={() => { /* TODO: settings */ }}>
          Settings &amp; account
        </button>
      </div>
    </nav>
  );
}
