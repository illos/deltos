import { lazy, Suspense, useCallback, useState } from 'react';
import type { NotebookId, NoteSort } from '@deltos/shared';
import { coerceNoteSort } from '../lib/noteSort.js';
import { mutateNotebooks } from '../db/mutateNotebooks.js';
import { notifyQueueWrite } from '../lib/syncEngine.js';
import { useAuthStore } from '../auth/store.js';
import { useCurrentNotebook } from '../db/storeHooks.js';
import { listCollectionViews } from '../lib/collectionViews.js';

// LAZY (plugins-lazy-past-first-paint / §4.3): ShareTarget pulls `shareApi` — keep it OFF the shell bundle.
// It only loads when the user EXPANDS "Share notebook" in this menu, not when the menu opens. The note Share
// screen already lazies its own copy via the ShareExportPanel chunk; this is the notebook mount point.
const ShareTarget = lazy(() => import('./ShareTarget.js').then((m) => ({ default: m.ShareTarget })));

/**
 * NotebookMenuBody — the FOUR notebook-context residents that fill the "…" menu (Rename · Share · Sort ·
 * View), per notebook-menu-and-keep-view.md §2. ONE content component, TWO containers: the mobile bottom-sheet
 * (ContextMenuSheet) and the desktop anchored popover (NotebookMenuPopover) each render it — the same
 * one-content/two-container discipline NavContent uses for DrawerNav + NavSheet. This carries NO overlay shell
 * of its own (the container owns backdrop/dismiss/geometry); it is only the resident rows.
 *
 * Residents (top→bottom, Close lives in the container's thumb zone):
 *   1. Rename  — inline field → mutateNotebooks.rename + notifyQueueWrite. Hidden for All Notes (null — no row).
 *   2. Share   — expands the (lazy) ShareTarget mint/manage panel, keyed by the current notebookId. Hidden for
 *      All Notes (nothing to share).
 *   3. Sort    — 4-mode single-select → mutateNotebooks.setNoteSort. Available for All Notes (sorts the
 *      aggregate device-locally; the null notebook has no synced row so the write is a no-op there — see below).
 *   4. View    — single-select of the REGISTERED collection views (List · Board · future Kanban) →
 *      mutateNotebooks.setDefaultCollectionView. Available for All Notes.
 *
 * All-Notes note: the synthetic aggregate has no notebook row, so Rename/Share are hidden and Sort/View writes
 * are no-ops (the mutators early-return on a missing notebook). Sort still renders so the aggregate can reflect
 * its mode; it just can't persist one until Jim is in a real notebook. This mirrors ShareLinkSection's
 * null-guard and App.tsx's All-Notes handling.
 */

const SORT_OPTIONS: ReadonlyArray<{ mode: NoteSort; label: string }> = [
  { mode: 'modified', label: 'Last modified' },
  { mode: 'alpha', label: 'Alphabetical' },
  { mode: 'created', label: 'Date created' },
  { mode: 'custom', label: 'Custom (drag to reorder)' },
];

/** A friendly label per registered collection-view key. Unknown keys fall back to the key itself. */
const VIEW_LABELS: Record<string, string> = { list: 'List', board: 'Board' };
function viewLabel(key: string): string {
  return VIEW_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

interface NotebookMenuBodyProps {
  /** The notebook whose options these are. null = the synthetic "All Notes" aggregate. */
  notebookId: NotebookId | null;
  /** Close the surrounding menu (called after a rename commit / etc.). */
  onClose: () => void;
}

type Expanded = null | 'rename' | 'share' | 'sort' | 'view';

export function NotebookMenuBody({ notebookId, onClose }: NotebookMenuBodyProps) {
  const notebook = useCurrentNotebook();
  const accountId = useAuthStore((s) => s.accountId);
  const isAllNotes = notebookId === null;
  // Which resident is expanded (in-place accordion; one at a time). Share reuses this as its expand latch.
  const [expanded, setExpanded] = useState<Expanded>(null);
  const [renameValue, setRenameValue] = useState('');

  const activeSort = coerceNoteSort(notebook?.noteSort);
  const activeView = notebook?.defaultCollectionView ?? 'list';
  // List of view options from the REGISTRY (§7) so registering a view auto-populates this menu. 'list' is the
  // unconditional default (the fallback view is never registered), so seed it first, then the registered keys.
  const registeredKeys = listCollectionViews().map((d) => d.key);
  const viewKeys = ['list', ...registeredKeys.filter((k) => k !== 'list')];

  const toggle = useCallback((row: Exclude<Expanded, null>) => {
    setExpanded((cur) => (cur === row ? null : row));
  }, []);

  const startRename = useCallback(() => {
    setRenameValue(notebook?.name ?? '');
    setExpanded('rename');
  }, [notebook?.name]);

  const commitRename = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = renameValue.trim();
      if (!trimmed || notebookId === null) { setExpanded(null); return; } // empty / All Notes → no-op
      await mutateNotebooks.rename(notebookId, trimmed);
      notifyQueueWrite(notebookId);
      setExpanded(null);
      onClose();
    },
    [renameValue, notebookId, onClose],
  );

  const chooseSort = useCallback(
    (mode: NoteSort) => {
      if (notebookId !== null) void mutateNotebooks.setNoteSort(notebookId, mode);
      setExpanded(null);
    },
    [notebookId],
  );

  const chooseView = useCallback(
    (view: string) => {
      if (notebookId !== null) void mutateNotebooks.setDefaultCollectionView(notebookId, view);
      setExpanded(null);
    },
    [notebookId],
  );

  return (
    <div className="nb-menu" aria-label="Notebook options">
      {/* 1 — RENAME (hidden for All Notes: no real row). */}
      {!isAllNotes && (
        expanded === 'rename' ? (
          <form className="nb-menu__rename" onSubmit={(e) => { void commitRename(e); }}>
            <input
              className="nb-menu__rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Notebook name"
              aria-label="Notebook name"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Escape') setExpanded(null); }}
            />
            <div className="nb-menu__rename-actions">
              <button type="submit" className="nb-menu__confirm">Save</button>
              <button type="button" className="nb-menu__cancel" onClick={() => setExpanded(null)}>Cancel</button>
            </div>
          </form>
        ) : (
          <button type="button" className="nb-menu__row" onClick={startRename}>
            <span className="nb-menu__row-label">Rename notebook</span>
          </button>
        )
      )}

      {/* 2 — SHARE (hidden for All Notes). Expands the lazy ShareTarget keyed by this notebook. */}
      {!isAllNotes && (
        <>
          <button
            type="button"
            className={`nb-menu__row${expanded === 'share' ? ' nb-menu__row--expanded' : ''}`}
            onClick={() => toggle('share')}
            aria-expanded={expanded === 'share'}
          >
            <span className="nb-menu__row-label">Share notebook</span>
            <span className="nb-menu__row-chevron" aria-hidden="true">{expanded === 'share' ? '▾' : '›'}</span>
          </button>
          {expanded === 'share' && (
            <div className="nb-menu__sub">
              <Suspense fallback={<div className="nb-menu__sub-loading auth__spinner" aria-label="Loading share…" />}>
                <ShareTarget
                  resourceType="notebook"
                  resourceId={notebookId}
                  heading="Share this notebook"
                  targetLabel={`the notebook “${notebook?.name ?? 'this notebook'}”`}
                  accountId={accountId}
                />
              </Suspense>
            </div>
          )}
        </>
      )}

      {/* 3 — SORT (all notebooks incl. All Notes). 4-mode single-select accordion. */}
      <button
        type="button"
        className={`nb-menu__row${expanded === 'sort' ? ' nb-menu__row--expanded' : ''}`}
        onClick={() => toggle('sort')}
        aria-expanded={expanded === 'sort'}
      >
        <span className="nb-menu__row-label">Sort</span>
        <span className="nb-menu__row-value">{SORT_OPTIONS.find((o) => o.mode === activeSort)?.label}</span>
        <span className="nb-menu__row-chevron" aria-hidden="true">{expanded === 'sort' ? '▾' : '›'}</span>
      </button>
      {expanded === 'sort' && (
        <div className="nb-menu__sub" role="radiogroup" aria-label="Sort notes by">
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.mode}
              type="button"
              role="radio"
              aria-checked={activeSort === o.mode}
              className={`nb-menu__option${activeSort === o.mode ? ' nb-menu__option--active' : ''}`}
              onClick={() => chooseSort(o.mode)}
            >
              <span className="nb-menu__option-check" aria-hidden="true">{activeSort === o.mode ? '✓' : ''}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}

      {/* 4 — VIEW (all notebooks). Single-select of the registered collection views. */}
      <button
        type="button"
        className={`nb-menu__row${expanded === 'view' ? ' nb-menu__row--expanded' : ''}`}
        onClick={() => toggle('view')}
        aria-expanded={expanded === 'view'}
      >
        <span className="nb-menu__row-label">View</span>
        <span className="nb-menu__row-value">{viewLabel(activeView)}</span>
        <span className="nb-menu__row-chevron" aria-hidden="true">{expanded === 'view' ? '▾' : '›'}</span>
      </button>
      {expanded === 'view' && (
        <div className="nb-menu__sub" role="radiogroup" aria-label="Collection view">
          {viewKeys.map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={activeView === key}
              className={`nb-menu__option${activeView === key ? ' nb-menu__option--active' : ''}`}
              onClick={() => chooseView(key)}
            >
              <span className="nb-menu__option-check" aria-hidden="true">{activeView === key ? '✓' : ''}</span>
              {viewLabel(key)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
