import { useState, useMemo, useCallback } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import type { NotebookId } from '@deltos/shared';
import { useNotebooks, useNotes } from '../db/storeHooks.js';
import { useNotebookStore } from '../lib/notebookStore.js';
import { mutateNotebooks } from '../db/mutateNotebooks.js';
import { notifyQueueWrite } from '../lib/syncEngine.js';
import { useIsDesktop } from '../lib/useIsDesktop.js';
import { useNoteDnd } from '../lib/dnd/useNoteDnd.js';
import { Notebook, BulletList, Plus, Trash, SettingsSliders } from '../icons/index.js';

interface NavContentProps {
  /** Called after a navigation action (notebook select, trash link). Lets the drawer/sheet close itself. */
  onNavigate?: () => void;
  /**
   * Show the δ deltos wordmark row. Default true — KEPT on desktop (DrawerNav), where it's the only place
   * the brand shows (Jim). The drag-up mobile sheet (NavSheet) passes false: the wordmark navigates to the
   * same place as All Notes there, so it's redundant.
   */
  showWordmark?: boolean;
}

/**
 * The single composable nav component (UI refresh, Lane 2 Pass C content treatment). One surface,
 * three containers: desktop left pane / mobile bottom sheet / cold-start full-screen.
 *
 * Built to the packet §1 nav spec: δ wordmark + "NOTEBOOKS" label + notebook rows (icon + name +
 * count). The current row gets an accent LEFT-BAR + accent icon (navSys-3's confirmed treatment,
 * refining §1's filled-bg). Per the packet there is NO per-row kebab/⋮ — the notebook-delete
 * affordance is deferred to the phase-2 interactive pass.
 *
 * All Notes (#59 synthetic aggregate) is pinned ABOVE the notebooks (Jim's call), same row geometry,
 * a distinct icon, undeletable. PROVISIONAL ("for now") — the icon + treatment may be refined later.
 */
export function NavContent({ onNavigate, showWordmark = true }: NavContentProps) {
  const notebooks = useNotebooks();
  const notes = useNotes();
  const currentNotebookId = useNotebookStore((s) => s.currentNotebookId);
  const setCurrentNotebook = useNotebookStore((s) => s.setCurrentNotebook);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const navigate = useNavigate();

  // Route-aware active highlight (Jim): the highlight answers "where am I NOW", not the persisted
  // notebook. On /settings* the Settings row is active; on /trash the Trash row is; on every notes route
  // (home / note list / note / new / search) the active notebook highlights exactly as before. Purely
  // presentational — the persisted currentNotebookId is untouched.
  const { pathname } = useLocation();
  const onSettingsRoute = pathname === '/settings' || pathname.startsWith('/settings/');
  const onTrashRoute = pathname === '/trash';
  const notebookHighlightActive = !onSettingsRoute && !onTrashRoute;
  // #79 desktop note→notebook DnD: notebook rows are drop targets (lazy chunk, desktop only). dropTarget
  // holds the highlighted row's key ('all' = All Notes, else the notebook id).
  const isDesktop = useIsDesktop();
  const noteDnd = useNoteDnd(isDesktop);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const countByNotebook = useMemo(() => {
    const m: Record<string, number> = {};
    for (const n of notes) {
      if (n.notebookId) m[n.notebookId] = (m[n.notebookId] ?? 0) + 1;
    }
    return m;
  }, [notes]);

  // Selecting a notebook (or null = All Notes) always navigates to the list.
  const handleSelect = useCallback(
    async (id: NotebookId | null) => {
      await setCurrentNotebook(id);
      navigate('/');
      onNavigate?.();
    },
    [setCurrentNotebook, navigate, onNavigate],
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
      {/* δ wordmark — δ is always Newsreader serif in --accent; "deltos" is always Plex Mono (invariants).
          Hidden in the drag-up sheet (showWordmark=false): redundant with All Notes there. Kept on desktop. */}
      {showWordmark && (
        <Link to="/" className="nav-content__wordmark" onClick={onNavigate}>
          <span className="dt-wordmark-delta nav-content__wordmark-delta">δ</span>
          <span className="nav-content__wordmark-text">deltos</span>
        </Link>
      )}

      <p className="dt-label nav-content__label">Notebooks</p>

      <ul className="nav-content__list">
        {/* All Notes — synthetic aggregate, pinned above the notebooks (Jim), distinct icon, undeletable.
            #79 drop target: dropping a note here uncategorizes it (notebookId → null). */}
        <li
          className={`nav-content__item${notebookHighlightActive && currentNotebookId === null ? ' nav-content__item--current' : ''}${dropTarget === 'all' ? ' nav-content__item--drop-target' : ''}`}
          onDragOver={noteDnd ? (e) => { if (noteDnd.allowNoteDrop(e)) setDropTarget('all'); } : undefined}
          onDragLeave={noteDnd ? () => setDropTarget((t) => (t === 'all' ? null : t)) : undefined}
          onDrop={noteDnd ? (e) => { void noteDnd.dropNoteOnNotebook(e, null); setDropTarget(null); } : undefined}
        >
          <button className="nav-content__nb-btn" onClick={() => { void handleSelect(null); }}>
            <BulletList className="nav-content__nb-icon" size={15} />
            <span className="nav-content__nb-name">All Notes</span>
            <span className="nav-content__nb-count">{notes.length}</span>
          </button>
        </li>
        {notebooks.map((nb) => (
          <li
            key={nb.id}
            className={`nav-content__item${notebookHighlightActive && nb.id === currentNotebookId ? ' nav-content__item--current' : ''}${dropTarget === nb.id ? ' nav-content__item--drop-target' : ''}`}
            onDragOver={noteDnd ? (e) => { if (noteDnd.allowNoteDrop(e)) setDropTarget(nb.id); } : undefined}
            onDragLeave={noteDnd ? () => setDropTarget((t) => (t === nb.id ? null : t)) : undefined}
            onDrop={noteDnd ? (e) => { void noteDnd.dropNoteOnNotebook(e, nb.id); setDropTarget(null); } : undefined}
          >
            <button className="nav-content__nb-btn" onClick={() => { void handleSelect(nb.id); }}>
              <Notebook className="nav-content__nb-icon" size={15} />
              <span className="nav-content__nb-name">{nb.name}</span>
              <span className="nav-content__nb-count">{countByNotebook[nb.id] ?? 0}</span>
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
            autoFocus
          />
          <div className="nav-content__new-actions">
            <button type="submit" className="nav-content__new-confirm">Create</button>
            <button type="button" className="nav-content__new-cancel" onClick={cancelCreate}>Cancel</button>
          </div>
        </form>
      ) : (
        <button className="nav-content__new-btn" onClick={() => setCreating(true)}>
          <Plus className="nav-content__nb-icon" size={15} />
          <span>New notebook</span>
        </button>
      )}

      <div className="nav-content__footer">
        <Link
          to="/trash"
          className={`nav-content__footer-link${onTrashRoute ? ' nav-content__footer-link--current' : ''}`}
          onClick={onNavigate}
        >
          <Trash className="nav-content__nb-icon" size={15} />
          <span>Trash</span>
        </Link>
        <button
          className={`nav-content__footer-link${onSettingsRoute ? ' nav-content__footer-link--current' : ''}`}
          onClick={() => { navigate('/settings'); onNavigate?.(); }}
        >
          <SettingsSliders className="nav-content__nb-icon" size={15} />
          <span>Settings</span>
        </button>
      </div>
    </nav>
  );
}
