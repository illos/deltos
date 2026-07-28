/**
 * CollectionsSection — inline accordion folders in the notebook note list (collections.md §5.1).
 *
 * LAZY: imported via React.lazy from HomeView so collection UI stays off the mobile first-load hot
 * path ([plugins-lazy-past-first-paint], CONV-0004). Only mounts when notebookId is a real notebook
 * (All Notes shows no accordions in v1).
 *
 * Expanded-open state lives in notebookStore (device-local, not synced). Member rows reuse the host's
 * note-row renderer so swipe/selection/preview stay identical to the flat list.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { CollectionId, Note, NoteId, NotebookId } from '@deltos/shared';
import { isTrashed } from '@deltos/shared';
import { useCollectionMembers, useCollections } from '../db/storeHooks.js';
import { useNotebookStore } from '../lib/notebookStore.js';
import type { CollectionRow } from '../db/schema.js';
import { CollectionMenuSheet } from './CollectionMenuSheet.js';

export interface CollectionsSectionProps {
  notebookId: NotebookId;
  /** Live notes (already non-trashed from useNotes); used for the local member join. */
  notes: readonly Note[];
  /** Render one member note with the SAME row component the flat list uses. */
  renderNoteRow: (note: Note, index: number) => ReactNode;
}

export function CollectionsSection({ notebookId, notes, renderNoteRow }: CollectionsSectionProps) {
  const all = useCollections();
  const collections = useMemo(
    () => all.filter((c) => c.notebookId === notebookId).sort((a, b) => a.ord - b.ord || a.name.localeCompare(b.name)),
    [all, notebookId],
  );
  const notesById = useMemo(() => {
    const m = new Map<NoteId, Note>();
    for (const n of notes) m.set(n.id, n);
    return m;
  }, [notes]);

  const [menuFor, setMenuFor] = useState<CollectionRow | null>(null);

  if (collections.length === 0) return null;

  return (
    <section className="home__collections" aria-label="Collections">
      {collections.map((c) => (
        <CollectionAccordion
          key={c.id}
          collection={c}
          notesById={notesById}
          renderNoteRow={renderNoteRow}
          onOpenMenu={() => setMenuFor(c)}
        />
      ))}
      {menuFor && (
        <CollectionMenuSheet
          collection={menuFor}
          onClose={() => setMenuFor(null)}
        />
      )}
    </section>
  );
}

interface AccordionProps {
  collection: CollectionRow;
  notesById: ReadonlyMap<NoteId, Note>;
  renderNoteRow: (note: Note, index: number) => ReactNode;
  onOpenMenu: () => void;
}

function CollectionAccordion({ collection, notesById, renderNoteRow, onOpenMenu }: AccordionProps) {
  const open = useNotebookStore((s) => s.openCollectionIds.has(collection.id));
  const toggle = useNotebookStore((s) => s.toggleCollectionOpen);
  const members = useCollectionMembers(collection.id);

  const memberNotes = useMemo(() => {
    const out: Note[] = [];
    for (const m of members) {
      const note = notesById.get(m.noteId);
      if (!note) continue;
      // useNotes already excludes trash, but belt-and-suspenders for stale maps.
      if (isTrashed(note.properties)) continue;
      out.push(note);
    }
    return out;
  }, [members, notesById]);

  const onToggle = useCallback(() => {
    toggle(collection.id as CollectionId);
  }, [toggle, collection.id]);

  return (
    <div className={`home__collection${open ? ' home__collection--open' : ''}`} data-collection-id={collection.id}>
      <div className="home__collection-header">
        <button
          type="button"
          className="home__collection-toggle"
          aria-expanded={open}
          aria-controls={`collection-body-${collection.id}`}
          onClick={onToggle}
        >
          <span className="home__collection-chevron" aria-hidden="true">{open ? '▾' : '›'}</span>
          {collection.icon && (
            <span className="home__collection-icon" aria-hidden="true">{collection.icon}</span>
          )}
          <span className="home__collection-name">{collection.name}</span>
          <span className="home__collection-count dt-meta--faint">{memberNotes.length}</span>
        </button>
        <button
          type="button"
          className="home__collection-menu"
          aria-label={`Manage collection ${collection.name}`}
          onClick={onOpenMenu}
        >
          …
        </button>
      </div>
      {open && (
        <ul
          id={`collection-body-${collection.id}`}
          className="home__collection-body home__notes"
          role="region"
          aria-label={`${collection.name} notes`}
        >
          {memberNotes.length === 0 ? (
            <li className="home__collection-empty">No notes in this collection</li>
          ) : (
            memberNotes.map((note, index) => renderNoteRow(note, index))
          )}
        </ul>
      )}
    </div>
  );
}
