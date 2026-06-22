import type { EditorState } from 'prosemirror-state';

/**
 * Selection-driven snapshot of which marks/block are active + undo/redo availability. Recomputed on
 * EVERY transaction (selection moves ARE transactions in PM), pushed to React once, and consumed by
 * the desktop toolbar, the mobile bar, and the tool-descriptor registry via `isToolActive(state, id)`
 * — so every surface lights up from one derivation. O(depth) per keystroke; never re-derives the doc.
 */
export interface EditorActiveState {
  marks: { bold: boolean; italic: boolean; underline: boolean; strike: boolean; highlight: boolean; code: boolean; link: boolean };
  block: 'title' | 'h1' | 'h2' | 'h3' | 'p' | 'pre' | 'quote' | 'todo' | 'ul' | 'ol' | null;
  canUndo: boolean;
  canRedo: boolean;
}

export const EMPTY_ACTIVE_STATE: EditorActiveState = {
  marks: { bold: false, italic: false, underline: false, strike: false, highlight: false, code: false, link: false },
  block: null,
  canUndo: false,
  canRedo: false,
};

// undoDepth/redoDepth live in prosemirror-history; import lazily-safe here to keep this module pure
// of view concerns. The editor passes the booleans in (it already tracks depth) — see ProseMirrorEditor.
function markActive(state: EditorState, name: string): boolean {
  const type = state.schema.marks[name];
  if (!type) return false;
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

function deriveBlock(state: EditorState): EditorActiveState['block'] {
  const { $from } = state.selection;
  const parent = $from.parent.type.name;
  // Textblock type wins for these (the cursor's immediate block).
  if (parent === 'title') return 'title';
  if (parent === 'code_block') return 'pre';
  if (parent === 'todo_item') return 'todo';
  if (parent === 'heading') {
    const level = $from.parent.attrs.level as number;
    return level === 1 ? 'h1' : level === 2 ? 'h2' : level === 3 ? 'h3' : 'h1';
  }
  // A plain paragraph: reflect the nearest wrapping container (list / quote) if any, else 'p'.
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'bullet_list') return 'ul';
    if (name === 'ordered_list') return 'ol';
    if (name === 'blockquote') return 'quote';
  }
  return 'p';
}

/**
 * Derive the active snapshot from editor state. `canUndo`/`canRedo` are passed in by the view (which
 * already tracks history depth) to keep this module free of the history plugin import.
 */
export function deriveActiveState(state: EditorState, canUndo = false, canRedo = false): EditorActiveState {
  return {
    marks: {
      bold: markActive(state, 'bold'),
      italic: markActive(state, 'italic'),
      underline: markActive(state, 'underline'),
      strike: markActive(state, 'strikethrough'),
      highlight: markActive(state, 'highlight'),
      code: markActive(state, 'code'),
      link: markActive(state, 'link'),
    },
    block: deriveBlock(state),
    canUndo,
    canRedo,
  };
}

/**
 * By-id active predicate — maps a UI `data-cmd` to whether it's currently active, so a toolbar button
 * or a registry descriptor asks `isToolActive(active, id)` without re-implementing the logic. Title
 * (`h1`) is active in the unified title node OR a body h1 (spec §2 title caveat).
 */
export function isToolActive(active: EditorActiveState, cmdId: string): boolean {
  switch (cmdId) {
    case 'bold':      return active.marks.bold;
    case 'italic':    return active.marks.italic;
    case 'underline': return active.marks.underline;
    case 'strike':    return active.marks.strike;
    case 'mark':      return active.marks.highlight;
    case 'code':      return active.marks.code;
    case 'link':      return active.marks.link;
    case 'h1':        return active.block === 'h1' || active.block === 'title';
    case 'h2':        return active.block === 'h2';
    case 'h3':        return active.block === 'h3';
    case 'p':         return active.block === 'p';
    case 'pre':       return active.block === 'pre';
    case 'ul':        return active.block === 'ul';
    case 'ol':        return active.block === 'ol';
    case 'check':     return active.block === 'todo';
    case 'quote':     return active.block === 'quote';
    default:          return false;
  }
}
