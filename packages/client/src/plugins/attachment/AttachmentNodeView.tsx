import { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Node as PmNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { AttachmentChip } from './AttachmentChip.js';
import { loadBlobUrl, downloadBlob, isInlineRenderableImage } from './blobClient.js';
import { useAuthStore } from '../../auth/store.js';
import { pluginRegistry } from '../runtime/index.js';
import { createBlockDragHandle, blockHandleStopEvent } from '../../editor/plugins/blockDragHandle.js';

interface AttachmentPayload {
  hash?: string;
  name?: string;
  mime?: string;
  size?: number;
}

/**
 * The in-editor attachment view (EDIT path, A4 #126). HARD secSys gate (#694): ONLY a known-safe image
 * (png/jpeg/gif/webp, via isInlineRenderableImage) is ever object-URL-rendered inline. Every other type —
 * html, svg, pdf, unknown — renders a DOWNLOAD chip, never an inline blob: URL (which for html/svg would
 * re-introduce the XSS the server prevents). The image path is the only one that fetches bytes into an
 * object URL; the render-only path stays fetch-free entirely.
 */
export function AttachmentView({ payload }: { payload: AttachmentPayload }) {
  const { hash, name, mime, size } = payload;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const safeImage = isInlineRenderableImage(mime);
  // Re-attempt the blob load when the bearer (re)appears. The editor is local-first: on a cold/offline
  // open it mounts BEFORE auth rehydrates, so the first blob GET can land with no bearer → 401 → reject.
  // Keying the effect on the token means that transient failure no longer LATCHES into a permanent bare
  // chip (the "image stopped previewing" bug) — when the refresh mints the token the load retries and the
  // image appears. loadBlobUrl is session-cached by hash, so a token rotation after success is a no-op.
  const bearerToken = useAuthStore((s) => s.bearerToken);

  useEffect(() => {
    if (!hash || !safeImage) return; // only safe images are ever loaded into an object URL
    let alive = true;
    setFailed(false); // fresh attempt: clear any prior latch so a now-valid bearer can succeed
    loadBlobUrl(hash, mime ?? '')
      .then((u) => { if (alive) setUrl(u); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [hash, mime, safeImage, bearerToken]);

  if (safeImage) {
    // safe image: inline once loaded; while loading / on failure, the chip (no inline render of nothing).
    if (url && !failed) return <img className="attachment-image" src={url} alt={name ?? ''} />;
    return <AttachmentChip name={name} mime={mime} size={size} />;
  }

  // non-image / unsafe type → a DOWNLOAD chip, NEVER an inline render.
  return (
    <button
      type="button"
      className="attachment-download"
      onClick={() => { if (hash) void downloadBlob(hash, name ?? 'download'); }}
      aria-label={`Download ${name ?? 'attachment'}`}
    >
      <AttachmentChip name={name} mime={mime} size={size} />
    </button>
  );
}

/** NodeView for an `attachment` plugin_block. Mounts AttachmentView; payload lives opaquely in node.attrs. */
export class AttachmentNodeView implements NodeView {
  readonly dom: HTMLElement;
  private root: Root;
  private readonly handle: HTMLElement;
  private readonly mount: HTMLElement;

  constructor(node: PmNode) {
    this.dom = document.createElement('div');
    this.dom.className = 'attachment-island';
    this.dom.contentEditable = 'false';
    // Drag handle (block-object-chrome): a grip that lets PM drag the whole draggable atom. The React view
    // mounts into a sibling so the handle is never inside the React-managed subtree.
    this.handle = createBlockDragHandle();
    this.mount = document.createElement('div');
    this.mount.className = 'block-object-body';
    this.dom.append(this.handle, this.mount);
    this.root = createRoot(this.mount);
    this.renderNode(node);
  }

  private renderNode(node: PmNode): void {
    // A6 #128: lazy migrate-on-open — bring an older-schemaVersion payload to current before rendering
    // (no-op while attachment is v1; the hook is live so a future v2 upgrades on open, never a bulk pass).
    const payload = pluginRegistry.migrateBlock('attachment', node.attrs.pluginContent ?? {}) as AttachmentPayload;
    this.root.render(<AttachmentView payload={payload} />);
  }

  update(node: PmNode): boolean {
    if (node.type.name !== 'plugin_block' || node.attrs.pluginType !== 'attachment') return false;
    this.renderNode(node);
    return true;
  }

  // Let a drag-start on the grip reach PM (so it drags the atom); keep PM out of the React interior otherwise.
  stopEvent(event: Event): boolean { return blockHandleStopEvent(this.handle, event); }
  ignoreMutation(): boolean { return true; }
  destroy(): void {
    // Defer so we never unmount synchronously inside a React render cycle (React 19 guard).
    const root = this.root;
    queueMicrotask(() => root.unmount());
  }
}

/** The island factory the manifest runtime registers for the `attachment` block type. */
export const attachmentIslandFactory = {
  create: (node: PmNode, _view: EditorView, _getPos: () => number | undefined) => new AttachmentNodeView(node),
};
