/**
 * ProseMirror slash-palette plugin (docs/specs/plugin-support.md §10.1, A5).
 * Detects `/` typed at block-start or after whitespace, tracks the query text,
 * and forwards Arrow/Enter/Escape to the React component via `dispatch`.
 * The component owns selection state + command execution; this plugin owns the
 * trigger, query tracking, and keyboard intercept.
 */
import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

export type PaletteEvent =
  | { type: 'open'; sliceStart: number; anchorLeft: number; anchorBottom: number }
  | { type: 'query'; query: string; sliceStart: number; anchorLeft: number; anchorBottom: number }
  | { type: 'close' }
  | { type: 'nav'; direction: 'up' | 'down' }
  | { type: 'enter'; sliceStart: number };

/**
 * Factory. `dispatch` is called with typed events; the plugin re-reads `enabledRef.current`
 * on each event so the palette can be toggled without recreating the view.
 */
export function createSlashPalettePlugin(
  dispatch: (event: PaletteEvent) => void,
  enabledRef: { readonly current: boolean },
): Plugin {
  // Position of the '/' in the doc while the palette is open.
  let sliceStart: number | null = null;
  // Position captured in handleTextInput, applied in the next update() cycle (post-DOM-render).
  let pendingSliceStart: number | null = null;
  // Last-dispatched query — avoids redundant React updates.
  let lastQuery = '';

  return new Plugin({
    props: {
      handleTextInput(view, from, _to, text) {
        if (!enabledRef.current) return false;
        if (sliceStart !== null || pendingSliceStart !== null) return false;
        if (text !== '/') return false;
        const { $from } = view.state.selection;
        // Don't trigger inside the title or code blocks.
        if ($from.parent.type.name === 'title' || $from.parent.type.name === 'code_block') return false;
        // Only trigger at block-start or immediately after whitespace (not mid-word).
        if ($from.parentOffset !== 0) {
          const nb = $from.nodeBefore;
          if (!nb?.isText || !/\s$/.test(nb.text ?? '')) return false;
        }
        pendingSliceStart = from; // '/' will land at position `from` once PM applies the transaction
        return false; // let PM insert the '/' normally
      },

      handleKeyDown(_view, event) {
        if (!enabledRef.current || sliceStart === null) return false;
        if (event.key === 'Escape') {
          sliceStart = null;
          lastQuery = '';
          dispatch({ type: 'close' });
          return true;
        }
        if (event.key === 'ArrowUp') {
          dispatch({ type: 'nav', direction: 'up' });
          return true;
        }
        if (event.key === 'ArrowDown') {
          dispatch({ type: 'nav', direction: 'down' });
          return true;
        }
        if (event.key === 'Enter') {
          const start = sliceStart;
          sliceStart = null;
          lastQuery = '';
          dispatch({ type: 'enter', sliceStart: start });
          return true;
        }
        return false;
      },
    },

    view() {
      return {
        update(view: EditorView) {
          // Pending open: '/' was just inserted and the DOM is current — safe to call coordsAtPos.
          if (pendingSliceStart !== null) {
            sliceStart = pendingSliceStart;
            pendingSliceStart = null;
            lastQuery = '';
            const coords = view.coordsAtPos(sliceStart + 1);
            dispatch({ type: 'open', sliceStart, anchorLeft: coords.left, anchorBottom: coords.bottom });
            return;
          }
          if (sliceStart === null) return;

          const { from, $from } = view.state.selection;
          // Cursor moved before the slash (e.g. Backspace at '/') → close.
          if (from <= sliceStart || from > view.state.doc.content.size) {
            sliceStart = null;
            lastQuery = '';
            dispatch({ type: 'close' });
            return;
          }
          // Cursor jumped to a different block → close.
          let sliceNode: ReturnType<typeof view.state.doc.resolve>;
          try {
            sliceNode = view.state.doc.resolve(sliceStart);
          } catch {
            sliceStart = null;
            lastQuery = '';
            dispatch({ type: 'close' });
            return;
          }
          if (sliceNode.parent !== $from.parent) {
            sliceStart = null;
            lastQuery = '';
            dispatch({ type: 'close' });
            return;
          }
          // Extract the query text after the '/' (everything from sliceStart+1 to cursor).
          let query: string;
          try {
            query = view.state.doc.textBetween(sliceStart + 1, from);
          } catch {
            sliceStart = null;
            lastQuery = '';
            dispatch({ type: 'close' });
            return;
          }
          if (query === lastQuery) return;
          lastQuery = query;
          const coords = view.coordsAtPos(sliceStart + 1);
          dispatch({ type: 'query', query, sliceStart, anchorLeft: coords.left, anchorBottom: coords.bottom });
        },
        destroy() {
          sliceStart = null;
          pendingSliceStart = null;
          lastQuery = '';
        },
      };
    },
  });
}
