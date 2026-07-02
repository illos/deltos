import { BlockIdSchema } from './ids.js';
import type { BlockId } from './ids.js';
import type { Block } from './block.js';

/**
 * The single shape of an attachment block's payload — the ONE block that backs a file-note, an inline file
 * embed, AND an inline image embed (image vs download-chip is a pure client render branch on `mime`, so one
 * block-building path covers all three). Defining it here in @deltos/shared (not the client plugin) lets BOTH
 * surfaces build the identical shape: the in-editor insert path + file-note creation on the CLIENT, and the
 * MCP write-tools on the WORKER (which cannot import client code). The client plugin re-exports these so its
 * existing imports keep working unchanged (file-notes.md §5.1 — "reuse the build helper, don't hand-roll a
 * divergent shape").
 *
 * It is what the spine stores as an attachment block's `content` and the PM node's `pluginContent` (the editor
 * serializer maps a `plugin_block` ↔ a spine block whose `type` = the pluginType).
 */

/**
 * `crypto.randomUUID()` reached through `globalThis` — the shared package builds against the ES2022 lib (no
 * DOM / WebWorker lib), so the `crypto` global isn't typed here, but it exists at runtime on every target
 * (browser, Workers, Node ≥ 19). This mirrors the client's `newBlockId()` id discipline without a lib change.
 */
const randomUuid = (): string =>
  (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();

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

/**
 * Build a single spine attachment BLOCK — the whole body of a file note, or one appended embed. Mirrors the
 * serializer's plugin_block map. The block id is a fresh UUID (branded via the spine schema) — the same
 * client-generated-id discipline `newBlockId()` uses, here so the worker can mint one without the client lib.
 */
export function buildAttachmentBlock(content: AttachmentContent): Block {
  return { id: BlockIdSchema.parse(randomUuid()) as BlockId, type: ATTACHMENT_PLUGIN_TYPE, content };
}
