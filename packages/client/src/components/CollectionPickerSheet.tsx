/**
 * CollectionPickerSheet — multi-select sheet to add/remove a note from the current notebook's
 * collections (+ create-new inline). Opened from the note swipe "Collect" surface.
 * Inputs ≥16px for iOS ([ios-input-16px-no-zoom]).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { collectionMemberId } from '@deltos/shared';
import type { CollectionId, NoteId, NotebookId } from '@deltos/shared';
import { useCollections } from '../db/storeHooks.js';
import { getStore } from '../db/store.js';
import { mutateCollections } from '../db/mutateCollections.js';
import { notifyQueueWrite } from '../lib/syncEngine.js';

interface CollectionPickerSheetProps {
  notebookId: NotebookId;
  noteId: NoteId;
  onClose: () => void;
}

export function CollectionPickerSheet({ notebookId, noteId, onClose }: CollectionPickerSheetProps) {
  const all = useCollections();
  const collections = useMemo(
    () => all.filter((c) => c.notebookId === notebookId).sort((a, b) => a.ord - b.ord || a.name.localeCompare(b.name)),
    [all, notebookId],
  );
  // Membership snapshot — refreshed when the user toggles (local put updates Dexie; we also track optimistically).
  const [memberOf, setMemberOf] = useState<Set<CollectionId>>(() => new Set());
  const [hydrated, setHydrated] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  // Hydrate membership on mount / when the notebook's collection set changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = new Set<CollectionId>();
      for (const c of collections) {
        const mid = collectionMemberId(c.id, noteId);
        const row = await getStore().getCollectionMember(mid);
        if (row && row.deletedAt === null) next.add(c.id);
      }
      if (!cancelled) {
        setMemberOf(next);
        setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [collections, noteId]);

  const toggle = useCallback(
    async (collectionId: CollectionId) => {
      const has = memberOf.has(collectionId);
      if (has) {
        await mutateCollections.removeNotes(collectionId, [noteId]);
        setMemberOf((prev) => {
          const n = new Set(prev);
          n.delete(collectionId);
          return n;
        });
      } else {
        await mutateCollections.addNotes(collectionId, [noteId]);
        setMemberOf((prev) => new Set(prev).add(collectionId));
      }
      notifyQueueWrite(notebookId);
    },
    [memberOf, noteId, notebookId],
  );

  const createAndAdd = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const id = await mutateCollections.create(notebookId, trimmed);
    await mutateCollections.addNotes(id, [noteId]);
    notifyQueueWrite(notebookId);
    setMemberOf((prev) => new Set(prev).add(id));
    setNewName('');
    setCreating(false);
  }, [newName, notebookId, noteId]);

  return (
    <div className="nb-sheet" role="dialog" aria-modal="true" aria-label="Add to collection">
      <div className="nb-sheet__backdrop" onClick={onClose} />
      <div className="nb-sheet__panel">
        <p className="nb-sheet__title">Add to collection</p>
        <ul className="nb-sheet__list">
          {collections.map((c) => {
            const checked = memberOf.has(c.id);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className={`nb-sheet__row${checked ? ' nb-sheet__row--current' : ''}`}
                  aria-pressed={checked}
                  disabled={!hydrated}
                  onClick={() => { void toggle(c.id); }}
                >
                  <span className="nb-menu__option-check" aria-hidden="true">{checked ? '✓' : ''}</span>
                  {c.icon ? `${c.icon} ` : ''}{c.name}
                </button>
              </li>
            );
          })}
        </ul>

        {creating ? (
          <form
            className="nb-menu__rename"
            onSubmit={(e) => { e.preventDefault(); void createAndAdd(); }}
          >
            <input
              className="nb-menu__rename-input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New collection name"
              aria-label="New collection name"
              autoFocus
            />
            <div className="nb-menu__rename-actions">
              <button type="submit" className="nb-menu__confirm">Create &amp; add</button>
              <button type="button" className="nb-menu__cancel" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <button type="button" className="nb-sheet__row" onClick={() => setCreating(true)}>
            + New collection
          </button>
        )}

        <button type="button" className="nb-sheet__cancel" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
