import './attachment.css';
import { formatFileSize } from './attachmentBlock.js';

export interface AttachmentChipProps {
  name?: string | undefined;
  mime?: string | undefined;
  size?: number | undefined;
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
      {size != null && <span className="attachment-chip__size">{formatFileSize(size)}</span>}
    </span>
  );
}
