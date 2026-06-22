import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { history, undo, redo, undoDepth, redoDepth } from 'prosemirror-history';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import type { BlockBody } from '@deltos/shared';
import { deltoSchema } from './schema.js';
import { uniqueBlockIdPlugin } from './plugins/blockId.js';
import { buildKeymapPlugin } from './keymap.js';
import { spineToPmDoc, pmDocToSpine, extractTitleFromDoc } from './serializer.js';
import { buildPluginIslandNodeViews } from './nodeviews/PluginIsland.js';
import { TodoItemView } from './nodeviews/TodoItem.js';
import { sliceToPlainText } from './clipboard.js';
import { EditorToolbar } from './EditorToolbar.js';
import { deriveActiveState, EMPTY_ACTIVE_STATE } from './editorState.js';
import type { EditorActiveState } from './editorState.js';
import type { ToolDescriptor } from './editorTools.js';
import { useIsDesktop } from '../lib/useIsDesktop.js';

interface ProseMirrorEditorProps {
  noteId: string;
  initialTitle: string;
  initialBody: BlockBody;
  onChange: (title: string, body: BlockBody) => void;
  autoFocus?: boolean;
  /** Called in effect cleanup after the final onChange flush — signals "left the note". */
  onLeave?: () => void;
  /** Test seam: called with the EditorView on creation and null on destruction. */
  onViewInit?: (view: EditorView | null) => void;
}

const SAVE_DEBOUNCE_MS = 400;
/** PM history group delay: continuous typing within this window collapses to one undo step. */
export const HISTORY_GROUP_DELAY_MS = 500;

/**
 * Decoration plugin: adds `data-empty` on the title node when it has no text content,
 * so CSS can show the 'Title' placeholder via ::before without touching PM's DOM.
 */
const titlePlaceholderPlugin = new Plugin({
  props: {
    decorations(state) {
      const first = state.doc.firstChild;
      if (!first || first.type.name !== 'title' || first.textContent !== '') return null;
      return DecorationSet.create(state.doc, [
        Decoration.node(0, first.nodeSize, { 'data-empty': '' }),
      ]);
    },
  },
});

/**
 * ProseMirror editor component. Manages the EditorView lifecycle imperatively;
 * React owns the mount/unmount, PM owns the document.
 *
 * The document structure is `title block*`: the first node is always the note title
 * (an h1 within the single contenteditable), and body blocks follow. This makes Enter
 * from title → body work natively, and drag-selection spans title + body in one gesture.
 *
 * When noteId changes (navigating to a different note), the view is destroyed and re-created
 * with the new document. Within a single note, all mutations go through PM transactions.
 *
 * Mobile IME note (iOS): ProseMirror handles composition events natively. The editor div
 * must NOT have `suppressContentEditableWarning` or other React-managed contenteditable
 * attributes — React's synthetic event system and ProseMirror's conflict on the same DOM node.
 * The ref div is passed to PM's constructor and React does not touch it thereafter.
 */
export function ProseMirrorEditor({
  noteId,
  initialTitle,
  initialBody,
  onChange,
  autoFocus = false,
  onLeave,
  onViewInit,
}: ProseMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const isDesktop = useIsDesktop();
  // One selection-driven snapshot drives every toolbar button + undo/redo availability.
  const [active, setActive] = useState<EditorActiveState>(EMPTY_ACTIVE_STATE);

  // Keep onChange and onLeave in refs so they're always current without re-running the effect.
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => { onChangeRef.current = onChange; });

  const onLeaveRef = useRef(onLeave);
  useLayoutEffect(() => { onLeaveRef.current = onLeave; });

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleUndo = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    undo(view.state, (tr) => view.dispatch(tr));
    view.focus();
  }, []);

  const handleRedo = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    redo(view.state, (tr) => view.dispatch(tr));
    view.focus();
  }, []);

  // Run a registry tool's command against the live view, then refocus (the button used
  // mouseDown+preventDefault to preserve the selection). The shared commands.ts layer means a toolbar
  // tap, a keymap shortcut, and a markdown input rule that mean the same thing run the same command.
  const runTool = useCallback((tool: ToolDescriptor) => {
    const view = viewRef.current;
    if (!view) return;
    tool.command(deltoSchema)(view.state, view.dispatch);
    view.focus();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    // Reset active state for the incoming note (fresh history, cursor unset).
    setActive(EMPTY_ACTIVE_STATE);

    const doc = spineToPmDoc(deltoSchema, initialBody, initialTitle);

    const state = EditorState.create({
      doc,
      plugins: [
        buildKeymapPlugin(deltoSchema),
        history({ newGroupDelay: HISTORY_GROUP_DELAY_MS }),
        dropCursor(),
        gapCursor(),
        uniqueBlockIdPlugin,
        titlePlaceholderPlugin,
      ],
    });

    const view = new EditorView(containerRef.current, {
      state,
      nodeViews: {
        ...buildPluginIslandNodeViews(deltoSchema),
        todo_item: (node, view, getPos) =>
          new TodoItemView(node, view, getPos as () => number | undefined),
      },
      // Plain text clipboard: markdown-flavoured structure for text/plain flavour.
      clipboardTextSerializer: sliceToPlainText,
      // Strip scripts and on* event handlers from HTML pasted from external sources.
      transformPastedHTML(html: string): string {
        const div = document.createElement('div');
        div.innerHTML = html;
        div.querySelectorAll('script, style, link, meta').forEach((el) => el.remove());
        div.querySelectorAll('*').forEach((el) => {
          const attrs = [...el.attributes];
          for (const attr of attrs) {
            if (attr.name.startsWith('on') || attr.name === 'style') {
              el.removeAttribute(attr.name);
            }
          }
        });
        return div.innerHTML;
      },
      dispatchTransaction(tr) {
        const newState = view.state.apply(tr);
        view.updateState(newState);

        // Recompute the selection-driven active snapshot on EVERY transaction (selection moves are
        // transactions too) so toolbar marks/block + undo/redo availability stay reactive from one place.
        setActive(deriveActiveState(newState, undoDepth(newState) > 0, redoDepth(newState) > 0));

        if (!tr.docChanged) return;

        if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = null;
          const title = extractTitleFromDoc(view.state.doc);
          const body = pmDocToSpine(view.state.doc);
          onChangeRef.current(title, body);
        }, SAVE_DEBOUNCE_MS);
      },
      // Flush the pending debounce on blur so the Dexie write starts before the route
      // change (iOS fires blur during the swipe-back gesture, ~300ms before navigation
      // completes — enough lead time for IndexedDB to finish before the list mounts).
      handleDOMEvents: {
        blur: () => {
          if (saveTimerRef.current !== null) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
            const title = extractTitleFromDoc(view.state.doc);
            const body = pmDocToSpine(view.state.doc);
            onChangeRef.current(title, body);
          }
          return false;
        },
      },
    });

    viewRef.current = view;
    setActive(deriveActiveState(view.state, false, false));
    onViewInit?.(view);
    if (autoFocus) view.focus();

    return () => {
      // Cleanup flush: covers programmatic unmounts where blur may not have fired.
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const title = extractTitleFromDoc(view.state.doc);
        const body = pmDocToSpine(view.state.doc);
        onChangeRef.current(title, body);
      }
      // Signal the note is being left (after the final save so Dexie has latest content).
      onLeaveRef.current?.();
      view.destroy();
      viewRef.current = null;
      onViewInit?.(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  return (
    <>
      {isDesktop ? (
        // Desktop: the registry-driven formatting toolbar (Deploy 3, slice C).
        <EditorToolbar active={active} run={runTool} />
      ) : (
        // Mobile: interim Undo/Redo toolbar — slice D replaces this with the grouped MobileEditorBar.
        <div className="editor__toolbar" role="toolbar" aria-label="Editing tools">
          <button className="editor__tool-btn" onClick={handleUndo} disabled={!active.canUndo} aria-label="Undo">
            Undo
          </button>
          <button className="editor__tool-btn" onClick={handleRedo} disabled={!active.canRedo} aria-label="Redo">
            Redo
          </button>
        </div>
      )}
      <div ref={containerRef} className="editor__pm" />
    </>
  );
}
