import type { ComponentType } from 'react';
import type { EditorState } from 'prosemirror-state';
import { NodeSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { KeyGrid } from './KeyGrid.js';

/**
 * KeyboardSurface — the reclaimed mobile keyboard FOOTPRINT as ONE context-driven surface (#69 north
 * star, spec §0/§2.3). Its entire contents are a pure function of the active context: not a permanent
 * keypad with a slot bolted on, but a layout chosen from a registry keyed by what's selected / which
 * plugin / note-type is active. The keypad is merely the layout registered for the default caret-in-text
 * context — replaceable AND hideable (an image block shows resize/crop controls and NO keypad; a table
 * cell shows cell controls; a context with no registered layout renders nothing).
 *
 * PM hands us the trigger for free: TextSelection (caret/range in text) vs NodeSelection (a block
 * selected). Phase 1 registers ONLY the text-context keypad, so the visible build is just the keypad —
 * but the surface already reacts to selection, so other contexts drop in additively, never a rewrite.
 */

export type KeyboardContext = string; // 'text' | `node:<typeName>` | future plugin / view keys

/** Context = pure function of the selection. NodeSelection → that node's context; else the text layout. */
export function deriveKeyboardContext(state: EditorState): KeyboardContext {
  const sel = state.selection;
  if (sel instanceof NodeSelection) return `node:${sel.node.type.name}`;
  return 'text';
}

interface LayoutProps { view: EditorView | null }

/**
 * Context → footprint layout. Phase 1 registers ONLY the text-context keypad; image / table / diagram /
 * plugin contexts register their own layouts here later — additively, no core change, nothing hardcoded.
 */
export const KEYBOARD_LAYOUTS: Record<string, ComponentType<LayoutProps>> = {
  text: KeyGrid,
};

interface KeyboardSurfaceProps {
  view: EditorView | null;
  /** The active context (host derives it via deriveKeyboardContext on selection change). */
  context: KeyboardContext;
}

export function KeyboardSurface({ view, context }: KeyboardSurfaceProps) {
  const Layout = KEYBOARD_LAYOUTS[context];
  if (!Layout) return null; // no layout for this context → footprint hidden
  return (
    <div className="kb" data-kb-context={context} role="group" aria-label="Keyboard">
      <Layout view={view} />
    </div>
  );
}
