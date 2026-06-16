import { useEffect, useLayoutEffect, useRef } from 'react';
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { history } from 'prosemirror-history';
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

interface ProseMirrorEditorProps {
  noteId: string;
  initialTitle: string;
  initialBody: BlockBody;
  onChange: (title: string, body: BlockBody) => void;
  autoFocus?: boolean;
}

const SAVE_DEBOUNCE_MS = 400;

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
}: ProseMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Keep onChange in a ref so it's always current without re-running the effect.
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => { onChangeRef.current = onChange; });

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const doc = spineToPmDoc(deltoSchema, initialBody, initialTitle);

    const state = EditorState.create({
      doc,
      plugins: [
        buildKeymapPlugin(deltoSchema),
        history(),
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
      view.destroy();
      viewRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  return <div ref={containerRef} className="editor__pm" />;
}
