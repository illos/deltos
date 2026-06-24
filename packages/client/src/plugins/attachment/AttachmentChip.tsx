import './attachment.css';

export interface AttachmentChipProps {
  name?: string | undefined;
  mime?: string | undefined;
  size?: number | undefined;
}

/** Human file size — 1 decimal past KB. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * Presentational attachment chip (§5 — ships presentation once; A4 #126). Zero ProseMirror, zero network:
 * an icon + filename + size. The read-only surfaces show this directly; the in-editor NodeView shows it for
 * non-image files (and as the offline/degraded form for images).
 */
export function AttachmentChip({ name, mime, size }: AttachmentChipProps) {
  return (
    <span className="attachment-chip" data-mime={mime}>
      <span className="attachment-chip__icon" aria-hidden="true">
        {mime?.startsWith('image/') ? '🖼️' : '📎'}
      </span>
      <span className="attachment-chip__name">{name ?? 'Attachment'}</span>
      {size != null && <span className="attachment-chip__size">{formatSize(size)}</span>}
    </span>
  );
}
