import { z } from 'zod';
import { BlockIdSchema } from './ids.js';
import type { BlockId } from './ids.js';

/**
 * The block body is the *document* half of the spine: an ordered, nestable tree. Each block
 * is an island — the core owns everything *between* blocks (order, nesting, selection); the
 * block's registered type (a core renderer or a plugin) owns everything *inside* it.
 *
 * Core block types are enumerated below for reference and tooling, but `type` is an OPEN
 * string: plugins register their own types and the spine never rejects an unknown one. This
 * is the single seam that serves editing, collaboration, and Markdown export at once.
 */

export const CORE_BLOCK_TYPES = [
  'heading',
  'paragraph',
  'list',
  'quote',
  'code',
  'todo',
  'divider',
  'image',
  'audio',
  'video',
  'file',
  'table',
] as const;

export type CoreBlockType = (typeof CORE_BLOCK_TYPES)[number];

/** Open by design: a core type or any plugin-registered type. Never enumerated as a closed set. */
export const BlockTypeSchema = z.string().min(1);
export type BlockType = z.infer<typeof BlockTypeSchema>;

/**
 * A block's `content` is OPAQUE to the spine — deliberately `unknown`, never `any`. The core
 * stores and transports it verbatim and only ever asks the registered block type to render,
 * export, or compute `searchText()` over it. This keeps the spine frozen while plugins are
 * purely additive.
 */
export interface Block {
  id: BlockId;
  type: BlockType;
  // Optional because some core blocks (e.g. `divider`) carry no content; opaque otherwise.
  content?: unknown;
  // `| undefined` is explicit so the interface matches Zod's `.optional()` output exactly
  // under `exactOptionalPropertyTypes` (required for the recursive `z.ZodType<Block>` annotation).
  children?: Block[] | undefined;
}

/**
 * Recursive schema. Zod requires the explicit `Block` interface above to type the
 * self-reference; the schema below remains the single runtime source of truth and the
 * interface is structurally checked against it (`z.ZodType<Block>`).
 */
export const BlockSchema: z.ZodType<Block, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    id: BlockIdSchema,
    type: BlockTypeSchema,
    content: z.unknown(),
    children: z.array(BlockSchema).optional(),
  }),
);

/** A note body is an ordered list of top-level blocks. */
export const BlockBodySchema = z.array(BlockSchema);
export type BlockBody = z.infer<typeof BlockBodySchema>;
