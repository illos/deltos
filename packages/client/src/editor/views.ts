import type { Note } from '@deltos/shared';
import type { ComponentType } from 'react';
import type { NoteEditorProps } from './NoteEditor.js';

/**
 * Note view resolution — the Phase-2 full-view seam.
 *
 * Every note rendered on a surface goes through `resolveNoteView(note)` rather than
 * hardcoding "a note is always the PM block editor." The spine stays monomorphic
 * (a note is always identity + properties + block body), but a note's view — the React
 * component that renders it — can vary by notebook capability or plugin registration.
 *
 * Phase 1 ships exactly one view: the block editor (ProseMirror). Phase 2 can call
 * `registerNoteView(key, predicate, component)` so that, e.g., a notebook with a
 * `kanban` plugin resolves to a board view instead of the block editor.
 *
 * The predicate receives the note and must be deterministic (no I/O) so resolution is
 * synchronous. The first registered view whose predicate matches wins; the block editor
 * is the unconditional fallback.
 */

export interface NoteViewDescriptor {
  readonly key: string;
  matches(note: Note): boolean;
  component: ComponentType<NoteEditorProps>;
}

const _registry: NoteViewDescriptor[] = [];

/** Register a non-default view. Phase 2+. */
export function registerNoteView(descriptor: NoteViewDescriptor): void {
  _registry.push(descriptor);
}

/**
 * Resolve which view component should render this note. Returns the first registered view
 * whose predicate matches, or the block editor if none do.
 *
 * Import the block editor lazily so this module has no hard dep on it — callers provide
 * the fallback component.
 */
export function resolveNoteView(
  note: Note,
  fallback: ComponentType<NoteEditorProps>,
): ComponentType<NoteEditorProps> {
  for (const descriptor of _registry) {
    if (descriptor.matches(note)) return descriptor.component;
  }
  return fallback;
}
