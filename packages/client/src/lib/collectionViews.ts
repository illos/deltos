import type { ComponentType } from 'react';
import type { NotebookId } from '@deltos/shared';

/**
 * Collection-view resolution — the per-notebook display seam.
 *
 * Every notebook list rendered in the shell goes through `resolveCollectionView(notebookId)`
 * rather than hardcoding "a notebook is always the standard list." v1 ships exactly one
 * collection view (the standard note list). v2+ can call `registerCollectionView` to add a
 * kanban, a calendar, a board view, etc. — as a registration, never a refactor.
 *
 * Mirrors the item-view seam (`editor/views.ts`): same pattern, different granularity.
 * Resolution predicate receives the notebook ID + the notebook's persisted view string and
 * must be deterministic (no I/O) so resolution stays synchronous. First registered view whose
 * predicate matches wins; the standard list is the unconditional fallback passed by the caller.
 *
 * The `view` arg (§6.1 option B): the caller reads the current notebook's synced
 * `defaultCollectionView` off its row and passes it in, so a view's `matches` is a pure string
 * check (`view === 'board'`) rather than reaching into async storage — resolution stays
 * synchronous AND data-driven off the synced row (the same field the View switcher persists).
 */

export interface CollectionViewProps {
  notebookId: NotebookId | null;
}

export interface CollectionViewDescriptor {
  readonly key: string;
  /** True iff this view should render for `notebookId` given its persisted `view` string. */
  matches(notebookId: NotebookId | null, view: string): boolean;
  component: ComponentType<CollectionViewProps>;
}

const _registry: CollectionViewDescriptor[] = [];

/** Register a non-default collection view. v2+. */
export function registerCollectionView(descriptor: CollectionViewDescriptor): void {
  _registry.push(descriptor);
}

/**
 * List the registered non-default collection views (§7). The View switcher renders its options from this
 * (plus the unconditional 'list' fallback the registry never holds), so registering a view AUTO-populates the
 * menu — adding a Kanban is registration-only, no menu edit. Returns a shallow copy (callers must not mutate).
 */
export function listCollectionViews(): readonly CollectionViewDescriptor[] {
  return _registry.slice();
}

/**
 * Resolve which collection-view component should render for this notebook. Returns the first
 * registered view whose predicate matches (given the notebook's persisted `view`), or `fallback`
 * (the standard list) if none do. `view` defaults to `'list'` so a caller that doesn't yet pass it
 * keeps the pre-feature behaviour (fallback list).
 */
export function resolveCollectionView(
  notebookId: NotebookId | null,
  fallback: ComponentType<CollectionViewProps>,
  view: string = 'list',
): ComponentType<CollectionViewProps> {
  for (const descriptor of _registry) {
    if (descriptor.matches(notebookId, view)) return descriptor.component;
  }
  return fallback;
}

/** @internal Reset the registry between tests. Do NOT call in production code. */
export function _clearRegistryForTest(): void {
  _registry.length = 0;
}
