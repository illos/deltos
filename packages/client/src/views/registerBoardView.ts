import { lazy, Suspense, createElement } from 'react';
import type { ComponentType } from 'react';
import { registerCollectionView } from '../lib/collectionViews.js';
import type { CollectionViewProps } from '../lib/collectionViews.js';

/**
 * Register the Keep-style Board view against the `resolveCollectionView` seam (notebook-menu-and-keep-view.md
 * §6.5). Imported ONCE at app init (App.tsx side-effect import), so the descriptor is in the registry before
 * any list resolves — but the Board component itself is a SEPARATE lazy chunk, so nothing but this tiny
 * predicate+lazy-ref module enters the entry bundle (perf north star / plugins-lazy-past-first-paint). Mirrors
 * registerFileNoteView exactly.
 *
 * `matches` is a PURE string check on the notebook's persisted `view` (§6.1 option B — the caller reads
 * `defaultCollectionView` off the synced row and passes it in), so resolution stays synchronous and data-driven
 * off the synced field the View switcher persists. resolveCollectionView requires a synchronous component, so we
 * hand it an eager descriptor whose `component` is a thin Suspense-wrapped lazy boundary.
 */

const LazyBoard = lazy(() => import('./Board.js').then((m) => ({ default: m.Board })));

const BoardLazy: ComponentType<CollectionViewProps> = (props) =>
  createElement(
    Suspense,
    { fallback: createElement('div', { className: 'board-view board-view--loading' }) },
    createElement(LazyBoard, props),
  );

registerCollectionView({ key: 'board', matches: (_id, view) => view === 'board', component: BoardLazy });
