import type { Block, BlockId, Note } from '@deltos/shared';
import { newBlockId } from '../../lib/ids.js';

/**
 * The single shape of an attachment block's payload — produced by BOTH the in-editor insert path
 * (drop / paste → inline block, attachmentDrop.ts) AND the file-note creation path (list-drop →
 * whole note, db/mutate.ts). Defining it once here keeps the two surfaces from drifting into
 * divergent shapes (file-notes.md §5.1 — "reuse the build helper, don't hand-roll a divergent
 * shape"). It is what the spine stores as a `plugin_block`'s `content` and the PM node's
 * `pluginContent` (the editor serializer maps `plugin_block` ↔ a spine block of `type` = pluginType).
 */

/** The plugin-block discriminator for attachments — the spine block `type` AND the PM node `pluginType`. */
export const ATTACHMENT_PLUGIN_TYPE = 'attachment' as const;

/** The attachment content payload: a content-addressed R2 blob plus its display metadata. */
export interface AttachmentContent {
  hash: string;
  name: string;
  mime: string;
  size: number;
}

/** Build the attachment content payload from an uploaded file + its stored-blob result (one shape, one place). */
export function buildAttachmentContent(
  file: { name: string; type: string },
  blob: { hash: string; size: number },
): AttachmentContent {
  return { hash: blob.hash, name: file.name, mime: file.type, size: blob.size };
}

/** Build a single spine attachment BLOCK — the whole body of a file note. Mirrors the serializer's plugin_block map. */
export function buildAttachmentBlock(content: AttachmentContent): Block {
  return { id: newBlockId() as BlockId, type: ATTACHMENT_PLUGIN_TYPE, content };
}

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
