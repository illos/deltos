/**
 * CollectionMenuSheet — manage one collection (rename / icon / color / delete).
 * Reuses the ContextMenuSheet / nb-sheet overlay language (bottom sheet + backdrop).
 * Inputs ≥16px for iOS ([ios-input-16px-no-zoom]).
 */
import { useCallback, useState } from 'react';
import type { CollectionId } from '@deltos/shared';
import { mutateCollections } from '../db/mutateCollections.js';
import { notifyQueueWrite } from '../lib/syncEngine.js';
import { useNotebookStore } from '../lib/notebookStore.js';
import type { CollectionRow } from '../db/schema.js';

interface CollectionMenuSheetProps {
  collection: CollectionRow;
  onClose: () => void;
}

type Mode = 'menu' | 'rename' | 'icon' | 'color';

export function CollectionMenuSheet({ collection, onClose }: CollectionMenuSheetProps) {
  const [mode, setMode] = useState<Mode>('menu');
  const [value, setValue] = useState('');
  const notebookId = useNotebookStore((s) => s.currentNotebookId);

  const nudge = useCallback(() => {
    if (notebookId) notifyQueueWrite(notebookId);
  }, [notebookId]);

  const commitRename = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed) { setMode('menu'); return; }
    await mutateCollections.rename(collection.id, trimmed);
    nudge();
    onClose();
  }, [value, collection.id, nudge, onClose]);

  const commitIcon = useCallback(async () => {
    const trimmed = value.trim();
    await mutateCollections.setIcon(collection.id, trimmed || undefined);
    nudge();
    onClose();
  }, [value, collection.id, nudge, onClose]);

  const commitColor = useCallback(async () => {
    const trimmed = value.trim();
    await mutateCollections.setColor(collection.id, trimmed || undefined);
    nudge();
    onClose();
  }, [value, collection.id, nudge, onClose]);

  const doDelete = useCallback(async () => {
    await mutateCollections.delete(collection.id as CollectionId);
    nudge();
    onClose();
  }, [collection.id, nudge, onClose]);

  return (
    <div className="nb-sheet" role="dialog" aria-modal="true" aria-label="Collection options">
      <div className="nb-sheet__backdrop" onClick={onClose} />
      <div className="nb-sheet__panel">
        <p className="nb-sheet__title">{collection.name}</p>

        {mode === 'menu' && (
          <ul className="nb-sheet__list">
            <li>
              <button
                type="button"
                className="nb-sheet__row"
                onClick={() => { setValue(collection.name); setMode('rename'); }}
              >
                Rename
              </button>
            </li>
            <li>
              <button
                type="button"
                className="nb-sheet__row"
                onClick={() => { setValue(collection.icon ?? ''); setMode('icon'); }}
              >
                Set icon
              </button>
            </li>
            <li>
              <button
                type="button"
                className="nb-sheet__row"
                onClick={() => { setValue(collection.color ?? ''); setMode('color'); }}
              >
                Set color
              </button>
            </li>
            <li>
              <button type="button" className="nb-sheet__row nb-sheet__row--danger" onClick={() => { void doDelete(); }}>
                Delete collection
              </button>
            </li>
          </ul>
        )}

        {mode === 'rename' && (
          <form
            className="nb-menu__rename"
            onSubmit={(e) => { e.preventDefault(); void commitRename(); }}
          >
            <input
              className="nb-menu__rename-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Collection name"
              aria-label="Collection name"
              autoFocus
              // iOS ≥16px: nb-menu__rename-input already uses 16px in styles.
            />
            <div className="nb-menu__rename-actions">
              <button type="submit" className="nb-menu__confirm">Save</button>
              <button type="button" className="nb-menu__cancel" onClick={() => setMode('menu')}>Back</button>
            </div>
          </form>
        )}

        {mode === 'icon' && (
          <form
            className="nb-menu__rename"
            onSubmit={(e) => { e.preventDefault(); void commitIcon(); }}
          >
            <input
              className="nb-menu__rename-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Emoji or icon token"
              aria-label="Collection icon"
              autoFocus
            />
            <div className="nb-menu__rename-actions">
              <button type="submit" className="nb-menu__confirm">Save</button>
              <button type="button" className="nb-menu__cancel" onClick={() => setMode('menu')}>Back</button>
            </div>
          </form>
        )}

        {mode === 'color' && (
          <form
            className="nb-menu__rename"
            onSubmit={(e) => { e.preventDefault(); void commitColor(); }}
          >
            <input
              className="nb-menu__rename-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Color token"
              aria-label="Collection color"
              autoFocus
            />
            <div className="nb-menu__rename-actions">
              <button type="submit" className="nb-menu__confirm">Save</button>
              <button type="button" className="nb-menu__cancel" onClick={() => setMode('menu')}>Back</button>
            </div>
          </form>
        )}

        <button type="button" className="nb-sheet__cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
