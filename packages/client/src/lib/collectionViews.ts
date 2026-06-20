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
 * Resolution predicate receives the notebook ID and must be deterministic (no I/O) so
 * resolution stays synchronous. First registered view whose predicate matches wins; the
 * standard list is the unconditional fallback passed by the caller.
 */

export interface CollectionViewProps {
  notebookId: NotebookId | null;
}

export interface CollectionViewDescriptor {
  readonly key: string;
  matches(notebookId: NotebookId | null): boolean;
  component: ComponentType<CollectionViewProps>;
}

const _registry: CollectionViewDescriptor[] = [];

/** Register a non-default collection view. v2+. */
export function registerCollectionView(descriptor: CollectionViewDescriptor): void {
  _registry.push(descriptor);
}

/**
 * Resolve which collection-view component should render for this notebook. Returns the first
 * registered view whose predicate matches, or `fallback` (the standard list) if none do.
 */
export function resolveCollectionView(
  notebookId: NotebookId | null,
  fallback: ComponentType<CollectionViewProps>,
): ComponentType<CollectionViewProps> {
  for (const descriptor of _registry) {
    if (descriptor.matches(notebookId)) return descriptor.component;
  }
  return fallback;
}

/** @internal Reset the registry between tests. Do NOT call in production code. */
export function _clearRegistryForTest(): void {
  _registry.length = 0;
}
