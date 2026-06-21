import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import type { ComponentType } from 'react';
import type { NotebookId } from '@deltos/shared';
import type { CollectionViewProps } from '../lib/collectionViews.js';
import { NavContent } from '../views/NavContent.js';
import { NoteRoute } from '../routes/NoteRoute.js';
import { NewNote } from '../routes/NewNote.js';
import { TrashRoute } from '../routes/TrashRoute.js';
import { SearchRoute } from '../routes/SearchRoute.js';
import { ResizeHandle } from './ResizeHandle.js';
import { EmptyNoteState } from './EmptyNoteState.js';
import { useResizableListPane } from '../lib/useResizableListPane.js';
import './ThreeRegionShell.css';

const SettingsRoute = lazy(() =>
  import('../routes/SettingsRoute.js').then((m) => ({ default: m.SettingsRoute })),
);

interface ThreeRegionShellProps {
  /** null = "All Notes" (the #59 synthetic first-class view / default landing), else a real notebook. */
  notebookId: NotebookId | null;
  /** The resolved collection view for the current notebook (passed in to avoid a circular App import). */
  CollectionView: ComponentType<CollectionViewProps>;
}

/**
 * Desktop / tablet-landscape 3-region shell (Lane 2 Pass B): a persistent NAV pane | resizable note
 * LIST | active NOTE master-detail. Rendered ONCE (above the router for the note region), so nav +
 * list stay mounted while the right region swaps content — the master-detail behavior.
 *
 * Per Jim's decision (a): Trash / Search / Settings ALSO render in region 3 (they replace the note
 * view; nav + list persist), so every route lives in the note region here.
 *
 * STATIC-VIBE frame (Pass B): region surfaces / borders / widths are built to the packet's literal
 * §Layout spec; the content treatment (nav-row + list-row + toolbars) and interactive affordances
 * are later phases. The list width is the device-local resizable width, with the --handle between
 * list and note.
 */
export function ThreeRegionShell({ notebookId, CollectionView }: ThreeRegionShellProps) {
  const { width, handleProps } = useResizableListPane();
  return (
    <div className="shell-3region">
      <aside className="shell-3region__nav" aria-label="Notebooks">
        <NavContent />
      </aside>

      <section className="shell-3region__list" style={{ width }}>
        <CollectionView notebookId={notebookId} />
      </section>

      <ResizeHandle handle={handleProps} />

      <main className="shell-3region__note">
        <Routes>
          <Route path="/note/:id" element={<NoteRoute />} />
          <Route path="/new" element={<NewNote />} />
          {/* Decision (a): these replace the note in region 3; nav + list stay visible. */}
          <Route path="/trash" element={<TrashRoute />} />
          <Route path="/search" element={<SearchRoute />} />
          <Route
            path="/settings"
            element={
              <Suspense fallback={<div className="empty-note" />}>
                <SettingsRoute />
              </Suspense>
            }
          />
          <Route path="/" element={<EmptyNoteState />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
