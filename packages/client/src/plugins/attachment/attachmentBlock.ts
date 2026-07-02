import type { Note } from '@deltos/shared';
import { ATTACHMENT_PLUGIN_TYPE } from '@deltos/shared';
import type { AttachmentContent } from '@deltos/shared';

/**
 * The attachment block builders now live in @deltos/shared (spine/attachmentBlock.ts) so the WORKER's MCP
 * write-tools can build the identical shape without importing client code. They are re-exported here so the
 * in-editor insert path (attachmentDrop.ts) and the file-note creation path (db/mutate.ts) keep importing
 * them from this module UNCHANGED — one shape, one source, no drift (file-notes.md §5.1). The file-note READ
 * helpers below (`fileNoteAttachment`, `formatFileSize`) are client-render concerns and stay here.
 */
export { ATTACHMENT_PLUGIN_TYPE, buildAttachmentContent, buildAttachmentBlock } from '@deltos/shared';
export type { AttachmentContent } from '@deltos/shared';

/**
 * Read a file note's attachment payload from its single body block (file-notes.md §2). FAIL-SAFE:
 * returns null if the body isn't a well-formed attachment block, so the list pill / viewer degrade
 * to the filename + a generic icon rather than throwing. `name`/`mime`/`size` fall back to sane
 * defaults (the note title for name) when a field is missing on cross-version data.
 */
export function fileNoteAttachment(note: Note): AttachmentContent | null {
  const block = note.body[0];
  if (!block || block.type !== ATTACHMENT_PLUGIN_TYPE) return null;
  const c = block.content as Partial<AttachmentContent> | null | undefined;
  if (!c || typeof c.hash !== 'string') return null;
  return {
    hash: c.hash,
    name: typeof c.name === 'string' ? c.name : note.title,
    mime: typeof c.mime === 'string' ? c.mime : '',
    size: typeof c.size === 'number' ? c.size : 0,
  };
}

/** Human file size — 1 decimal past KB. Shared by the attachment chip + the file-note list pill. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
