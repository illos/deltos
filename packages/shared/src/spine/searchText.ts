import type { Block } from './block.js';

/**
 * Plaintext extraction over the spine {@link Block} tree — the SERVER's source of the FTS `body`
 * column (packages/worker/src/db/searchIndex.ts). It is deliberately here in `@deltos/shared`, not
 * in the worker, so the extractor is a single frozen contract if the client ever needs the same
 * whole-document serialization (the client's lib/search.ts derives its own PREVIEW-shaped text; this
 * is the FULL-document one).
 *
 * Content is OPAQUE to the spine (Block.content is `unknown`), so extraction is tolerant by design:
 * it reads the two known text-bearing shapes — `{ segments: [{ text }] }` (rich-text runs) and
 * `{ code }` (code blocks) — and returns '' for anything else (dividers, images, unknown plugin
 * blocks). An unknown block never throws; it simply contributes no text.
 *
 * CRUCIAL divergence from the client's blockToText (lib/search.ts): that one walks only the TOP-LEVEL
 * body array and ignores `block.children`, so nested list/quote content is invisible to it. The FTS
 * index must be complete, so {@link blocksToPlainText} recurses depth-first INCLUDING `children`.
 */

/** Text carried directly by one block's `content` (NOT its children). Tolerant of any/unknown shape. */
export function blockContentText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const o = content as Record<string, unknown>;
  if (Array.isArray(o['segments'])) {
    return (o['segments'] as Array<Record<string, unknown>>)
      .map((s) => (s && typeof s['text'] === 'string' ? s['text'] : ''))
      .join('');
  }
  if (typeof o['code'] === 'string') return o['code'];
  return '';
}

/**
 * Full plaintext of a note body: every block's own text PLUS all descendant blocks', depth-first,
 * joined by single spaces. Unlike the client preview extractor this recurses through `block.children`
 * so nested content (list items, nested quotes, table-cell blocks) is indexed. Empty contributions
 * are dropped so the result has no runs of blank separators.
 */
export function blocksToPlainText(body: readonly Block[]): string {
  const out: string[] = [];
  const walk = (blocks: readonly Block[]): void => {
    for (const block of blocks) {
      const t = blockContentText(block.content);
      if (t) out.push(t);
      if (block.children && block.children.length) walk(block.children);
    }
  };
  walk(body);
  return out.join(' ');
}

/**
 * Tolerantly parse a STORED body (the JSON-encoded `Block[]` string in `notes.body`) to plaintext.
 * Returns '' for null/empty/malformed JSON or a non-array parse — the FTS body column is best-effort
 * and must never make a mutation throw. Callers pass `row.body` (the authoritative read-back).
 */
export function bodyJsonToPlainText(bodyJson: string | null | undefined): string {
  if (!bodyJson) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson);
  } catch {
    return '';
  }
  if (!Array.isArray(parsed)) return '';
  return blocksToPlainText(parsed as Block[]);
}
