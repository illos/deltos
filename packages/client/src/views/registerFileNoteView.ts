import { lazy, Suspense, createElement } from 'react';
import type { ComponentType } from 'react';
import { isFileNote } from '@deltos/shared';
import { registerNoteView } from '../editor/views.js';
import type { NoteEditorProps } from '../editor/NoteEditor.js';

/**
 * Register the FileNoteView against the `resolveNoteView` seam (file-notes.md §3.2). Imported ONCE at app
 * init (App.tsx, side-effect import) so the descriptor is in the registry before any note opens; NoteRoute
 * already consumes `resolveNoteView(note, NoteEditor)` (L197), so a file note resolves here and a normal
 * note falls through to the PM editor — no route change needed.
 *
 * Perf (gate FN-8): the actual viewer is `lazy(() => import('./FileNoteView.js'))`, so FileNoteView and its
 * blob deps are a SEPARATE chunk — this registration module is tiny (a predicate + a lazy ref) and is the
 * only thing the entry bundle pulls in. resolveNoteView stays synchronous (the seam requires it): we hand
 * it an eager descriptor whose `component` is a thin Suspense-wrapped lazy boundary (NoteRoute renders the
 * resolved component directly, without its own Suspense, so the boundary lives here).
 */

const LazyFileNoteView = lazy(() =>
  import('./FileNoteView.js').then((m) => ({ default: m.FileNoteView })),
);

const FileNoteViewLazy: ComponentType<NoteEditorProps> = (props) =>
  createElement(
    Suspense,
    { fallback: createElement('div', { className: 'editor editor--loading' }) },
    createElement(LazyFileNoteView, props),
  );

registerNoteView({ key: 'file', matches: isFileNote, component: FileNoteViewLazy });
