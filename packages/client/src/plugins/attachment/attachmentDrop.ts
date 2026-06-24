import { Plugin, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { DeltoSchema } from '../../editor/schema.js';
import { uploadBlob } from './blobClient.js';

/**
 * Attachment INSERT path (A4 #132) — drop / paste a file → upload to the blob capability → embed. This is a
 * small EAGER plugin (rides the manifest's editorPlugins seam, like the link_card paste handler), so it's
 * always listening; the HEAVY node-view runtime stays lazy and loads on the first file. Mirrors the
 * link_card loading-then-fill pattern: insert a loading block immediately, upload async, then fill it.
 *
 * Dynamic-imports the registry (not a static import) to avoid the builtins↔index cycle, and so this stays
 * out of the eager graph's static deps.
 */

async function ensureRuntimeLoaded(): Promise<void> {
  const { pluginRegistry } = await import('../runtime/index.js');
  await pluginRegistry.loadRuntime('attachment'); // registers the attachment island NodeView (idempotent)
}

/** Recreate node-views (no doc change) so a just-registered island factory upgrades placeholder blocks. */
function refreshNodeViews(view: EditorView): void {
  view.setProps({ nodeViews: { ...(view.props.nodeViews ?? {}) } });
}

interface LoadingContent {
  token: string;
}

function insertLoadingBlock(view: EditorView, schema: DeltoSchema, file: File, token: string): void {
  const pluginBlock = schema.nodes['plugin_block'];
  if (!pluginBlock) return;
  const node = pluginBlock.create({
    pluginType: 'attachment',
    pluginContent: { name: file.name, mime: file.type, size: file.size, loading: true, token },
  });
  // replaceSelectionWith handles placing a block atom at the caret (splitting/lifting as needed) — the same
  // path the link_card paste uses. The caller positions the selection (drop → drop coords; paste → caret).
  view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
}

/** Find the loading block by its token (position may have shifted) and replace its payload. */
function fillBlock(view: EditorView, token: string, content: Record<string, unknown>): void {
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.type.name === 'plugin_block' && node.attrs.pluginType === 'attachment') {
      const c = node.attrs.pluginContent as Partial<LoadingContent> | null;
      if (c?.token === token) { at = pos; return false; }
    }
    return true;
  });
  if (at < 0) return;
  const node = view.state.doc.nodeAt(at);
  if (!node) return;
  view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, pluginContent: content }));
}

async function handleFiles(view: EditorView, schema: DeltoSchema, files: File[]): Promise<void> {
  // Insert the loading blocks IMMEDIATELY (synchronously, at the caret) for instant feedback; each
  // replaceSelectionWith leaves the caret after the atom, so multiple files stack in order.
  const tokens = files.map(() => crypto.randomUUID());
  files.forEach((file, i) => insertLoadingBlock(view, schema, file, tokens[i]!));
  // Then load the (lazy) node-view runtime + upload, and fill each block as its upload completes.
  await ensureRuntimeLoaded();
  if (view.isDestroyed) return;
  refreshNodeViews(view);
  await Promise.all(
    files.map(async (file, i) => {
      try {
        const { hash, size } = await uploadBlob(file);
        fillBlock(view, tokens[i]!, { hash, name: file.name, mime: file.type, size });
      } catch {
        fillBlock(view, tokens[i]!, { name: file.name, mime: file.type, size: file.size, error: true });
      }
    }),
  );
}

function docHasAttachment(view: EditorView): boolean {
  let found = false;
  view.state.doc.descendants((node) => {
    if (!found && node.type.name === 'plugin_block' && node.attrs.pluginType === 'attachment') found = true;
  });
  return found;
}

export function attachmentDropPlugin(schema: DeltoSchema): Plugin {
  return new Plugin({
    // lazy-load-on-open: a note that already has attachment blocks loads the runtime + upgrades the
    // placeholders to the real view on mount (no doc change).
    view(editorView) {
      if (docHasAttachment(editorView)) {
        void ensureRuntimeLoaded().then(() => { if (!editorView.isDestroyed) refreshNodeViews(editorView); });
      }
      return {};
    },
    props: {
      handleDOMEvents: {
        drop(view, event) {
          const files = event.dataTransfer?.files;
          if (!files || files.length === 0) return false;
          event.preventDefault();
          // Move the caret to the drop point so the block lands where the file was dropped.
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (at) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at.pos)));
          void handleFiles(view, schema, [...files]);
          return true;
        },
      },
      // Pasted image(s): intercept ONLY when the clipboard carries files; text/URL paste falls through to
      // the core paste handlers (e.g. the link_card bare-URL handler).
      handlePaste(view, event) {
        const files = event.clipboardData?.files;
        if (!files || files.length === 0) return false;
        void handleFiles(view, schema, [...files]);
        return true;
      },
    },
  });
}
