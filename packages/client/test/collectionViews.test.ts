/**
 * Collection-view seam tests — the per-notebook display resolver.
 *
 * Covered:
 *   CV-1  resolveCollectionView returns the fallback when the registry is empty
 *   CV-2  a registered view is returned when its predicate matches
 *   CV-3  the fallback is returned when no registered view predicate matches
 *   CV-4  additivity: a second view can be registered and resolved independently —
 *         proves the seam is open for extension without touching existing views.
 *   CV-5  first-registered-wins when multiple views match the same notebook
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ComponentType } from 'react';
import type { NotebookId } from '@deltos/shared';
import {
  registerCollectionView,
  resolveCollectionView,
  _clearRegistryForTest,
} from '../src/lib/collectionViews.js';
import type { CollectionViewProps } from '../src/lib/collectionViews.js';

// Minimal stub components (not rendered — only their identity matters here).
const StandardListView = (() => null) as unknown as ComponentType<CollectionViewProps>;
const KanbanView = (() => null) as unknown as ComponentType<CollectionViewProps>;
const VoiceView = (() => null) as unknown as ComponentType<CollectionViewProps>;

const NB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NotebookId;

beforeEach(() => _clearRegistryForTest());

describe('CV-1 — empty registry returns fallback', () => {
  it('returns the fallback component when no views are registered', () => {
    const resolved = resolveCollectionView(NB_A, StandardListView);
    expect(resolved).toBe(StandardListView);
  });
});

describe('CV-2 — registered view returned when predicate matches', () => {
  it('returns the registered view for the matching notebook', () => {
    registerCollectionView({
      key: 'kanban',
      matches: (id) => id === NB_A,
      component: KanbanView,
    });
    expect(resolveCollectionView(NB_A, StandardListView)).toBe(KanbanView);
  });
});

describe('CV-3 — fallback returned when no predicate matches', () => {
  it('returns the fallback for a notebook that no registered view covers', () => {
    registerCollectionView({
      key: 'kanban',
      matches: (id) => id === NB_A,
      component: KanbanView,
    });
    expect(resolveCollectionView(NB_B, StandardListView)).toBe(StandardListView);
  });
});

describe('CV-4 — additivity: a second view registers and resolves independently', () => {
  it('two views with distinct predicates each resolve to their own component', () => {
    registerCollectionView({
      key: 'kanban',
      matches: (id) => id === NB_A,
      component: KanbanView,
    });
    registerCollectionView({
      key: 'voice',
      matches: (id) => id === NB_B,
      component: VoiceView,
    });

    expect(resolveCollectionView(NB_A, StandardListView)).toBe(KanbanView);
    expect(resolveCollectionView(NB_B, StandardListView)).toBe(VoiceView);
    // An unmatched notebook still returns the fallback — existing views untouched.
    const NB_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as NotebookId;
    expect(resolveCollectionView(NB_C, StandardListView)).toBe(StandardListView);
  });
});

describe('CV-5 — first-registered-wins on overlap', () => {
  it('returns the first view whose predicate matches when multiple could', () => {
    registerCollectionView({ key: 'first', matches: () => true, component: KanbanView });
    registerCollectionView({ key: 'second', matches: () => true, component: VoiceView });
    expect(resolveCollectionView(NB_A, StandardListView)).toBe(KanbanView);
  });
});
