import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useMatch } from 'react-router-dom';
import type { ComponentType } from 'react';
import type { NotebookId } from '@deltos/shared';
import type { CollectionViewProps } from '../lib/collectionViews.js';
import { NavContent } from '../views/NavContent.js';
import { SettingsRail } from '../routes/settings/SettingsRail.js';
import { NewNote } from '../routes/NewNote.js';
import { TrashRoute } from '../routes/TrashRoute.js';
import { SearchRoute } from '../routes/SearchRoute.js';
import { ResizeHandle } from './ResizeHandle.js';
import { EmptyNoteState } from './EmptyNoteState.js';
import { useResizableListPane } from '../lib/useResizableListPane.js';
import './ThreeRegionShell.css';

// LAZY: the note editor is the heaviest subtree (PM + all plugins) — split out of the entry so the
// desktop shell paints first; loads on note-open (precached → instant warm). The OTHER static entry-point
// (App.tsx mobile route) must lazy it too, else Rollup keeps it in the entry.
const NoteRoute = lazy(() => import('../routes/NoteRoute.js').then((m) => ({ default: m.NoteRoute })));
const SettingsRoute = lazy(() =>
  import('../routes/SettingsRoute.js').then((m) => ({ default: m.SettingsRoute })),
);

interface ThreeRegionShellProps {
  /** null = "All Notes" (the #59 synthetic first-class view / default landing), else a real notebook. */
  notebookId: NotebookId | null;
  /** The resolved collection view for the current notebook (passed in to avoid a circular App import). */
  CollectionView: ComponentType<CollectionViewProps>;
  /**
   * True when the resolved view is the Keep Board (§6.3 pane-dissolve): the middle list + right note panes
   * collapse into ONE full-width grid region (the Board renders its own note popover-over-blur), the resize
   * handle is hidden. The nav pane stays. Default false = the normal list|handle|note triple.
   */
  boardMode?: boolean;
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
export function ThreeRegionShell({ notebookId, CollectionView, boardMode = false }: ThreeRegionShellProps) {
  const { width, handleProps } = useResizableListPane();
  // On a /settings route the middle (list) pane becomes the settings tab RAIL, replacing the notes
  // list — the same slot the notes flow fills, so pane widths/borders stay consistent (settings-revamp
  // desktop 3-column shell: notebooks nav → tab rail → content).
  const settingsIndexMatch = useMatch('/settings');
  const settingsTabMatch = useMatch('/settings/:tab');
  const onSettings = settingsIndexMatch != null || settingsTabMatch != null;
  // Board pane-dissolve (§6.3): a full-width single grid region (list+note collapsed), nav pane kept, no
  // resize handle, no note region — the Board renders its own note popover. Suppressed on /settings /trash
  // /search (those aren't the notes flow), which fall back to the normal list|handle|note triple below.
  const onOffFlowRoute = onSettings || useMatch('/trash') != null || useMatch('/search') != null;
  if (boardMode && !onOffFlowRoute) {
    return (
      <div className="shell-3region shell-3region--board">
        <aside className="shell-3region__nav" aria-label="Notebooks">
          <NavContent />
        </aside>
        <section className="shell-3region__board">
          <CollectionView notebookId={notebookId} />
        </section>
      </div>
    );
  }
  return (
    <div className="shell-3region">
      <aside className="shell-3region__nav" aria-label="Notebooks">
        <NavContent />
      </aside>

      <section className="shell-3region__list" style={{ width }}>
        {onSettings ? <SettingsRail /> : <CollectionView notebookId={notebookId} />}
      </section>

      <ResizeHandle handle={handleProps} />

      <main className="shell-3region__note">
        <Routes>
          <Route
            path="/note/:id"
            element={
              <Suspense fallback={<div className="editor__pm" aria-busy="true" />}>
                <NoteRoute />
              </Suspense>
            }
          />
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
          <Route
            path="/settings/:tab"
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
