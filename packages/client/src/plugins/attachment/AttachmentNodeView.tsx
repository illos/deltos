import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Node as PmNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { AttachmentChip } from './AttachmentChip.js';
import { loadBlobUrl, downloadBlob, isInlineRenderableImage } from './blobClient.js';
import { useAuthStore } from '../../auth/store.js';
import { pluginRegistry } from '../runtime/index.js';
import { createBlockDragHandle, blockHandleStopEvent } from '../../editor/plugins/blockDragHandle.js';
import { computeResizeWidth, applyWidthToContent } from './imageResize.js';

interface AttachmentPayload {
  hash?: string;
  name?: string;
  mime?: string;
  size?: number;
  /** Persisted display width in CSS px (DEC-0001 salvage: drag-resize). Absent → natural size. Rides the
   *  opaque pluginContent into the spine, so it syncs with no schema/migration change. */
  width?: number;
}

/**
 * The in-editor attachment view (EDIT path, A4 #126). HARD secSys gate (#694): ONLY a known-safe image
 * (png/jpeg/gif/webp, via isInlineRenderableImage) is ever object-URL-rendered inline. Every other type —
 * html, svg, pdf, unknown — renders a DOWNLOAD chip, never an inline blob: URL (which for html/svg would
 * re-introduce the XSS the server prevents). The image path is the only one that fetches bytes into an
 * object URL; the render-only path stays fetch-free entirely.
 */
export function AttachmentView({
  payload,
  onCommitWidth,
}: {
  payload: AttachmentPayload;
  /** Persist a new display width (px), or undefined to reset to natural. Absent in the render-free/test path.
   *  `| undefined` is explicit for exactOptionalPropertyTypes — the caller forwards a possibly-undefined value. */
  onCommitWidth?: ((width: number | undefined) => void) | undefined;
}) {
  const { hash, name, mime, size } = payload;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const safeImage = isInlineRenderableImage(mime);
  // Re-attempt the blob load when the auth state (re)settles. The editor is local-first: on a cold/offline
  // open it mounts BEFORE auth rehydrates, so the first blob GET can land with no bearer → 401 → reject.
  // Keying the effect on the token means that transient failure no longer LATCHES into a permanent bare
  // chip (the "image stopped previewing" bug) — when the refresh mints the token the load retries and the
  // image appears. loadBlobUrl is session-cached by hash, so a token rotation after success is a no-op.
  // Also key on accountId: the cache path (fetchBytesCached) is account-scoped, and on cold boot accountId
  // can settle a beat AFTER the bearer — re-fire so the IndexedDB tier engages once the account resolves.
  // (loadBlobUrl itself now re-mints + retries on a 403/expired token, so the common warm-open stale-token
  // case resolves on the FIRST attempt without needing a bearer-identity change here.)
  const bearerToken = useAuthStore((s) => s.bearerToken);
  const accountId = useAuthStore((s) => s.accountId);

  useEffect(() => {
    if (!hash || !safeImage) return; // only safe images are ever loaded into an object URL
    let alive = true;
    setFailed(false); // fresh attempt: clear any prior latch so a now-valid bearer can succeed
    loadBlobUrl(hash, mime ?? '')
      .then((u) => { if (alive) setUrl(u); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [hash, mime, safeImage, bearerToken, accountId]);

  if (safeImage) {
    // safe image: inline once loaded; while loading / on failure, the chip (no inline render of nothing).
    if (url && !failed) {
      return <ResizableImage src={url} alt={name ?? ''} width={payload.width} onCommitWidth={onCommitWidth} />;
    }
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

/**
 * The inline image plus its drag-to-resize grip (DEC-0001 salvage). The persisted `width` comes down as a
 * prop; a live drag is tracked in local state so the image follows the pointer WITHOUT dispatching a PM
 * transaction per move (perf north-star — one commit on release, not per frame). `overrideWidth` holds both
 * the in-flight drag width and the just-committed width so there is no flash between pointerup and the payload
 * re-render (both null → fall back to the persisted `width` prop → natural when that too is absent).
 */
export function ResizableImage({
  src,
  alt,
  width,
  onCommitWidth,
}: {
  src: string;
  alt: string;
  width: number | undefined;
  onCommitWidth?: ((width: number | undefined) => void) | undefined;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [overrideWidth, setOverrideWidth] = useState<number | null>(null);
  // The grab-point snapshot captured on pointerdown; null when no drag is in flight.
  const drag = useRef<{ startX: number; startWidth: number; naturalWidth: number } | null>(null);

  const effectiveWidth = overrideWidth ?? width; // live drag / just-committed wins, else persisted, else natural
  const resizable = !!onCommitWidth; // the render-free/test path passes no committer → static image

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    const img = imgRef.current;
    if (!img) return;
    e.preventDefault();
    e.stopPropagation(); // keep the grab off PM's selection/drag machinery
    e.currentTarget.setPointerCapture(e.pointerId); // route move/up here even as the pointer leaves the grip
    drag.current = {
      startX: e.clientX,
      startWidth: img.getBoundingClientRect().width, // measured px whether or not an explicit width is set yet
      naturalWidth: img.naturalWidth,
    };
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!drag.current) return;
    const { startX, startWidth, naturalWidth } = drag.current;
    setOverrideWidth(computeResizeWidth(startWidth, e.clientX - startX, naturalWidth));
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // Commit the final width to the spine in ONE transaction. overrideWidth stays set so the image doesn't snap
    // back to natural for the frame before the payload prop catches up.
    if (overrideWidth != null) onCommitWidth?.(overrideWidth);
  }

  // Double-tap / double-click the grip → drop the explicit width, back to natural size.
  function onReset(): void {
    setOverrideWidth(null);
    onCommitWidth?.(undefined);
  }

  const imgStyle = effectiveWidth != null ? { width: `${effectiveWidth}px` } : undefined;
  return (
    <span className="attachment-image-wrap">
      <img ref={imgRef} className="attachment-image" src={src} alt={alt} style={imgStyle} draggable={false} />
      {resizable && (
        <span
          className="attachment-resize-grip"
          role="slider"
          aria-label="Drag to resize image"
          aria-valuenow={effectiveWidth ?? 0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onReset}
        />
      )}
    </span>
  );
}

/** NodeView for an `attachment` plugin_block. Mounts AttachmentView; payload lives opaquely in node.attrs. */
export class AttachmentNodeView implements NodeView {
  readonly dom: HTMLElement;
  private root: Root;
  private readonly handle: HTMLElement;
  private readonly mount: HTMLElement;

  constructor(
    node: PmNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
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

  /** Persist a new image display width (or reset to natural when `width` is undefined) in one PM transaction.
   *  Re-reads the node fresh at getPos() — positions shift, so never close over the constructor's stale node. */
  private commitWidth = (width: number | undefined): void => {
    const pos = this.getPos();
    if (pos == null) return;
    const cur = this.view.state.doc.nodeAt(pos);
    if (!cur || cur.type.name !== 'plugin_block' || cur.attrs.pluginType !== 'attachment') return;
    const content = applyWidthToContent((cur.attrs.pluginContent ?? {}) as AttachmentPayload, width);
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, pluginContent: content }));
  };

  private renderNode(node: PmNode): void {
    // A6 #128: lazy migrate-on-open — bring an older-schemaVersion payload to current before rendering
    // (no-op while attachment is v1; the hook is live so a future v2 upgrades on open, never a bulk pass).
    const payload = pluginRegistry.migrateBlock('attachment', node.attrs.pluginContent ?? {}) as AttachmentPayload;
    this.root.render(<AttachmentView payload={payload} onCommitWidth={this.commitWidth} />);
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
  create: (node: PmNode, view: EditorView, getPos: () => number | undefined) =>
    new AttachmentNodeView(node, view, getPos),
};
