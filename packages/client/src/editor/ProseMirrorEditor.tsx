import { useEffect, useLayoutEffect, useRef } from 'react';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history } from 'prosemirror-history';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import type { BlockBody } from '@deltos/shared';
import { deltoSchema } from './schema.js';
import { uniqueBlockIdPlugin } from './plugins/blockId.js';
import { buildKeymapPlugin } from './keymap.js';
import { spineToPmDoc, pmDocToSpine } from './serializer.js';
import { buildPluginIslandNodeViews } from './nodeviews/PluginIsland.js';
import { TodoItemView } from './nodeviews/TodoItem.js';
import { sliceToPlainText } from './clipboard.js';

interface ProseMirrorEditorProps {
  noteId: string;
  initialBody: BlockBody;
  onChange: (body: BlockBody) => void;
  autoFocus?: boolean;
}

const SAVE_DEBOUNCE_MS = 400;

/**
 * ProseMirror editor component. Manages the EditorView lifecycle imperatively;
 * React owns the mount/unmount, PM owns the document.
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
  initialBody,
  onChange,
  autoFocus = false,
}: ProseMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Keep onChange in a ref so it's always current without re-running the effect.
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => { onChangeRef.current = onChange; });

  // Debounce state
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const doc = spineToPmDoc(deltoSchema, initialBody);

    const state = EditorState.create({
      doc,
      plugins: [
        buildKeymapPlugin(deltoSchema),
        history(),
        dropCursor(),
        gapCursor(),
        uniqueBlockIdPlugin,
      ],
    });

    const view = new EditorView(containerRef.current, {
      state,
      nodeViews: {
        ...buildPluginIslandNodeViews(deltoSchema),
        todo_item: (node, view, getPos) =>
          new TodoItemView(node, view, getPos as () => number | undefined),
      },
      // Plain text clipboard output: readable markdown-flavoured text for system clipboard.
      // PM's default collapses everything to textContent — losing all structure. This makes
      // "copy from deltos, paste into email/terminal" produce something the user can read.
      clipboardTextSerializer: sliceToPlainText,
      // Strip scripts and on* event handlers from HTML pasted from external sources.
      // PM's own parser handles structural sanitization; this removes the XSS surface.
      // The uniqueBlockIdPlugin then re-mints any IDs that arrive null or duplicated.
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

        // Debounce: collapse rapid keystrokes into a single save call.
        if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = null;
          const body = pmDocToSpine(view.state.doc);
          onChangeRef.current(body);
        }, SAVE_DEBOUNCE_MS);
      },
    });

    viewRef.current = view;
    if (autoFocus) view.focus();

    return () => {
      // Flush any pending debounced save before destroying.
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const body = pmDocToSpine(view.state.doc);
        onChangeRef.current(body);
      }
      view.destroy();
      viewRef.current = null;
    };
  // Re-create the view only when the note changes, not on every onChange reference update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  return <div ref={containerRef} className="editor__pm" />;
}
