import type { Node as PmNode, Schema } from 'prosemirror-model';
import type { Block, BlockBody, BlockId } from '@deltos/shared';
import { BlockIdSchema } from '@deltos/shared';
import { newBlockId } from '../lib/ids.js';

/**
 * Spine-native rich text format for text-bearing blocks. Opaque to the spine itself
 * (which stores `content: unknown`); only the editor and future export surfaces interpret it.
 *
 * Round-trip invariant: spineToPmDoc(pmDocToSpine(doc)) produces a semantically identical doc.
 */
export interface TextSegment {
  text: string;
  bold?: true;
  italic?: true;
  code?: true;
  underline?: true;   // NEW
  strike?: true;      // NEW — maps the schema mark 'strikethrough'
  highlight?: true;   // NEW
  math?: true;        // LEGACY — old inline-math MARK (pre-framework). Read-only: upgraded to a formula
                      // node on load (segmentsToPmInline); never written. Kept for back-compat with chips
                      // persisted before the formula framework (docs/specs/inline-formulas.md §2 shim).
  formula?: { type: string; state: unknown }; // NEW — inline-formula node: text = the spec; type + state
                      // attrs. The result is NEVER stored (recomputed on render). No migration.
  link?: string; // href
}

// Per-block content types (the `unknown` in Block is one of these at runtime):
export interface ParagraphContent { segments: TextSegment[] }
export interface HeadingContent   { level: 1|2|3|4|5|6; segments: TextSegment[] }
export interface QuoteContent     { segments: TextSegment[] }  // top-level inline only; children for nested blocks
export interface CodeContent      { code: string; language?: string }
export interface TodoContent      { checked: boolean; segments: TextSegment[] }
export interface ListContent      { ordered: boolean }
// divider: no content (undefined)

// ── Runtime content guards (schema-first interpretation boundary) ────────────────────────────
//
// Notes body crosses the sync boundary (device → device, version → version). Unchecked casts
// on block.content would crash spineBlockToPmNode on malformed/cross-version data. These guards
// validate at the editor's interpretation point so that bad content degrades to an empty block
// rather than throwing and breaking the entire note for the user.

function isString(x: unknown): x is string { return typeof x === 'string'; }
function isBool(x: unknown): x is boolean   { return typeof x === 'boolean'; }

export function isTextSegment(x: unknown): x is TextSegment {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  // schema.text('') throws RangeError — empty text nodes are never valid in PM.
  if (!isString(o['text']) || o['text'].length === 0) return false;
  if ('bold' in o && o['bold'] !== true) return false;
  if ('italic' in o && o['italic'] !== true) return false;
  if ('code' in o && o['code'] !== true) return false;
  if ('underline' in o && o['underline'] !== true) return false;
  if ('strike' in o && o['strike'] !== true) return false;
  if ('highlight' in o && o['highlight'] !== true) return false;
  if ('math' in o && o['math'] !== true) return false;
  if ('formula' in o) {
    const f = o['formula'];
    if (!f || typeof f !== 'object' || !isString((f as Record<string, unknown>)['type'])) return false;
  }
  if ('link' in o && !isString(o['link'])) return false;
  // Forward-compatible: unknown future flags are ignored, not rejected.
  return true;
}

function parseSegments(raw: unknown): TextSegment[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isTextSegment);
}

function parseLevel(raw: unknown): 1|2|3|4|5|6 {
  if (raw === 1 || raw === 2 || raw === 3 || raw === 4 || raw === 5 || raw === 6) return raw;
  return 1;
}

function parseParagraphContent(raw: unknown): ParagraphContent {
  if (raw && typeof raw === 'object') {
    return { segments: parseSegments((raw as Record<string, unknown>)['segments']) };
  }
  return { segments: [] };
}

function parseHeadingContent(raw: unknown): HeadingContent {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    return { level: parseLevel(o['level']), segments: parseSegments(o['segments']) };
  }
  return { level: 1, segments: [] };
}

function parseQuoteContent(raw: unknown): QuoteContent {
  if (raw && typeof raw === 'object') {
    return { segments: parseSegments((raw as Record<string, unknown>)['segments']) };
  }
  return { segments: [] };
}

function parseCodeContent(raw: unknown): CodeContent {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    return {
      code: isString(o['code']) ? o['code'] : '',
      ...(isString(o['language']) ? { language: o['language'] } : {}),
    };
  }
  return { code: '' };
}

function parseTodoContent(raw: unknown): TodoContent {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    return {
      checked: isBool(o['checked']) ? o['checked'] : false,
      segments: parseSegments(o['segments']),
    };
  }
  return { checked: false, segments: [] };
}

function parseListContent(raw: unknown): ListContent {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    return { ordered: isBool(o['ordered']) ? o['ordered'] : false };
  }
  return { ordered: false };
}

// ── PM doc → spine ────────────────────────────────────────────────────────────────────────

// Convert ONE inline child into a segment (or null for nodes that aren't text-bearing inline — e.g. a
// SPIKE inline plugin_block, which a textblock-level caller hoists into its own spine block instead).
function inlineChildToSegment(child: PmNode): TextSegment | null {
  if (child.type.name === 'hard_break') return { text: '\n' };
  // Inline-formula node → a formula segment: text = the spec, plus { type, state }. The result is NOT
  // stored (recomputed on render). The math MARK is no longer emitted (math is a formula node now); the
  // mark stays parse-only in the schema for clipboard back-compat + the load-time upgrade shim.
  if (child.type.name === 'formula') {
    return {
      text: child.textContent,
      formula: { type: child.attrs.ftype as string, state: child.attrs.state ?? null },
    };
  }
  if (child.type.name !== 'text') return null;
  const seg: TextSegment = { text: child.text ?? '' };
  if (child.marks.some((m) => m.type.name === 'bold'))          seg.bold      = true;
  if (child.marks.some((m) => m.type.name === 'italic'))        seg.italic    = true;
  if (child.marks.some((m) => m.type.name === 'code'))          seg.code      = true;
  if (child.marks.some((m) => m.type.name === 'underline'))     seg.underline = true;
  if (child.marks.some((m) => m.type.name === 'strikethrough')) seg.strike    = true;
  if (child.marks.some((m) => m.type.name === 'highlight'))     seg.highlight = true;
  const linkMark = child.marks.find((m) => m.type.name === 'link');
  if (linkMark) seg.link = linkMark.attrs.href as string;
  return seg;
}

function inlineToSegments(node: PmNode): TextSegment[] {
  const segments: TextSegment[] = [];
  node.forEach((child) => {
    const seg = inlineChildToSegment(child);
    if (seg) segments.push(seg);
  });
  return segments;
}

/**
 * SPIKE (Mechanic A): build a spine `plugin_block` Block from an inline plugin_block PM node. Reads its
 * attrs identically to the legacy block-atom path — the spine shape (a top-level Block of `pluginType`,
 * carrying the opaque `pluginContent`) is UNCHANGED by the inline re-model. This is the round-trip seam.
 */
function pluginNodeToBlock(node: PmNode): Block {
  const id = (node.attrs.id as string | null) ?? (newBlockId() as string);
  return {
    id: id as BlockId,
    type: (node.attrs.pluginType as string) || 'plugin_block',
    content: node.attrs.pluginContent as unknown,
  };
}

/**
 * SPIKE (Mechanic A): a textblock (paragraph) may now CONTAIN inline plugin_block atoms. Split it into spine
 * blocks in document order: runs of text/inline collapse into paragraph blocks, each plugin_block becomes
 * its OWN top-level spine block (preserving the legacy spine shape). The pure-text case returns a single
 * paragraph (zero behavioural change); the isolated-object case (a paragraph holding ONLY the atom) returns
 * just the plugin block (no synthetic empty paragraph), which is the round-trip inverse of the wrap below.
 */
function textblockToBlocks(node: PmNode, paragraphId: string): Block[] {
  let hasPlugin = false;
  node.forEach((c) => { if (c.type.name === 'plugin_block') hasPlugin = true; });
  if (!hasPlugin) {
    return [{ id: paragraphId as BlockId, type: 'paragraph', content: { segments: inlineToSegments(node) } satisfies ParagraphContent }];
  }
  const out: Block[] = [];
  let buffer: TextSegment[] = [];
  let usedParagraphId = false;
  const flush = () => {
    if (buffer.length === 0) return;
    const pid = usedParagraphId ? (newBlockId() as string) : paragraphId;
    usedParagraphId = true;
    out.push({ id: pid as BlockId, type: 'paragraph', content: { segments: buffer } satisfies ParagraphContent });
    buffer = [];
  };
  node.forEach((child) => {
    if (child.type.name === 'plugin_block') {
      flush();
      out.push(pluginNodeToBlock(child));
      return;
    }
    const seg = inlineChildToSegment(child);
    if (seg) buffer.push(seg);
  });
  flush();
  return out;
}

function pmNodeToBlock(node: PmNode): Block | Block[] | null {
  const id = (node.attrs.id as string | null) ?? (newBlockId() as string);

  switch (node.type.name) {
    case 'paragraph':
      // SPIKE (Mechanic A): a paragraph may carry inline plugin_block atoms → split them back out to their
      // own top-level spine blocks (legacy shape). Pure-text paragraphs return a single block, unchanged.
      return textblockToBlocks(node, id);

    case 'heading': {
      const content: HeadingContent = {
        level: node.attrs.level as 1|2|3|4|5|6,
        segments: inlineToSegments(node),
      };
      return { id: id as BlockId, type: 'heading', content };
    }

    case 'blockquote': {
      // blockquote contains blocks; render its first paragraph as content, rest as children.
      const children: Block[] = [];
      node.forEach((child) => {
        const converted = pmNodeToBlock(child);
        if (converted) {
          if (Array.isArray(converted)) children.push(...converted);
          else children.push(converted);
        }
      });
      // Use text content of first child for a flat content field (for search/preview)
      const firstChild = children[0];
      const segments =
        firstChild?.type === 'paragraph'
          ? (firstChild.content as ParagraphContent | undefined)?.segments ?? []
          : [];
      const content: QuoteContent = { segments };
      const restChildren = children.slice(segments.length > 0 ? 1 : 0);
      const block: Block = { id: id as BlockId, type: 'quote', content };
      if (restChildren.length > 0) block.children = restChildren;
      return block;
    }

    case 'code_block': {
      const content: CodeContent = {
        code: node.textContent,
        ...(node.attrs.language ? { language: node.attrs.language as string } : {}),
      };
      return { id: id as BlockId, type: 'code', content };
    }

    case 'todo_item': {
      const content: TodoContent = {
        checked: node.attrs.checked as boolean,
        segments: inlineToSegments(node),
      };
      return { id: id as BlockId, type: 'todo', content };
    }

    case 'horizontal_rule':
      return { id: id as BlockId, type: 'divider' };

    case 'bullet_list':
    case 'ordered_list': {
      const ordered = node.type.name === 'ordered_list';
      const children: Block[] = [];
      node.forEach((listItem) => {
        // Each list_item contains a paragraph (or todo_item) + optional nested list.
        // Map: list_item id becomes the paragraph block id; nested lists become children of it.
        const itemId = (listItem.attrs.id as string | null) ?? (newBlockId() as string);
        let segments: TextSegment[] = [];
        let checked: boolean | undefined;
        const itemChildren: Block[] = [];

        listItem.forEach((child) => {
          if (child.type.name === 'paragraph') {
            segments = inlineToSegments(child);
          } else if (child.type.name === 'todo_item') {
            segments = inlineToSegments(child);
            checked = child.attrs.checked as boolean;
          } else {
            // Nested list
            const nested = pmNodeToBlock(child);
            if (nested) {
              if (Array.isArray(nested)) itemChildren.push(...nested);
              else itemChildren.push(nested);
            }
          }
        });

        const itemBlock: Block =
          checked !== undefined
            ? { id: itemId as BlockId, type: 'todo', content: { checked, segments } satisfies TodoContent }
            : { id: itemId as BlockId, type: 'paragraph', content: { segments } satisfies ParagraphContent };

        if (itemChildren.length > 0) itemBlock.children = itemChildren;
        children.push(itemBlock);
      });

      const listContent: ListContent = { ordered };
      const listBlock: Block = { id: id as BlockId, type: 'list', content: listContent };
      if (children.length > 0) listBlock.children = children;
      return listBlock;
    }

    case 'plugin_block': {
      return {
        id: id as BlockId,
        type: node.attrs.pluginType as string || 'plugin_block',
        content: node.attrs.pluginContent as unknown,
      };
    }

    default:
      return null;
  }
}

/**
 * Extract the note title from the PM document's first `title` node.
 * Returns an empty string if the doc has no title node or the node is empty.
 */
export function extractTitleFromDoc(doc: PmNode): string {
  const first = doc.firstChild;
  return first?.type.name === 'title' ? first.textContent : '';
}

// ── Spine block-id sanitization (the load-bearing fix for the render-only id leak) ───────────
//
// spineToPmDoc emits DETERMINISTIC render-only ids for wrapper/inner nodes — a plugin-block wrapper
// paragraph `${atomId}~w`, a blockquote first paragraph `${quoteId}~q`, an empty-list fallback item
// `${listId}~empty` — so the #90 reconcile echo-guard (`incoming.eq(doc)`) short-circuits and undo
// survives autosave (GOTCHA-0005 / serializerDeterminism.undo.test.ts). Those ids are normally DISCARDED
// on the way back: pmDocToSpine keys each spine block on the PARENT's persisted id. But when such a
// wrapper paragraph is ORPHANED — e.g. a plugin/attachment atom is deleted, leaving the empty
// `${atomId}~w` paragraph behind — pmDocToSpine serializes it as a plain paragraph that STILL carries the
// `~w` id, leaking a non-UUID into the persisted/synced spine. The spine's BlockIdSchema is a strict UUID,
// so ONE such block fails SyncPushEntrySchema → the worker 400s the WHOLE push batch → every queued edit
// wedges behind it (the confirmed prod incident). Re-minting any non-UUID id at THIS boundary (the single
// place PM nodes become the persisted spine) catches `~w`/`~q`/`~empty` AND any other malformed id,
// permanently.
//
// Idempotency / undo are preserved: a VALID UUID is returned UNCHANGED (no re-mint), so a clean note —
// whose blocks all carry real UUIDs — round-trips byte-for-byte and the undo-determinism guarantee holds.
// Re-minting only ever fires for a genuinely-non-UUID id, which a normal note never produces. Only the
// OUTPUT side (pmDocToSpine) sanitizes; spineToPmDoc keeps emitting the deterministic render-only ids the
// reconcile guard relies on.

/** True iff `id` is a valid spine block id (a UUID per BlockIdSchema). */
export function isValidBlockId(id: unknown): id is BlockId {
  return BlockIdSchema.safeParse(id).success;
}

function sanitizeBlock(block: Block): Block {
  const id: BlockId = isValidBlockId(block.id) ? block.id : newBlockId();
  let children = block.children;
  if (children) {
    const next = children.map(sanitizeBlock);
    // Preserve reference identity (and thus value-stability) when nothing in the subtree changed.
    if (next.some((c, i) => c !== children![i])) children = next;
  }
  if (id === block.id && children === block.children) return block;
  return children === undefined ? { ...block, id } : { ...block, id, children };
}

/**
 * Re-mint every non-UUID block id (recursively, including nested children) so the spine NEVER carries a
 * render-only / malformed id. A no-op (value-stable) for a clean note — see the block comment above. Also
 * reused by the sync engine to REPAIR an already-leaked queued note in place (self-heal).
 */
export function sanitizeBlockIds(blocks: BlockBody): BlockBody {
  return blocks.map(sanitizeBlock);
}

/**
 * Convert the ProseMirror document to the spine block body.
 * Skips the first `title` node — the title is extracted via extractTitleFromDoc().
 */
export function pmDocToSpine(doc: PmNode): BlockBody {
  const blocks: Block[] = [];
  doc.forEach((node, _offset, index) => {
    if (index === 0 && node.type.name === 'title') return; // skip title node
    const converted = pmNodeToBlock(node);
    if (converted) {
      if (Array.isArray(converted)) blocks.push(...converted);
      else blocks.push(converted);
    }
  });
  // Sanitize at THE boundary: a non-UUID block id (e.g. an orphaned `${id}~w` wrapper paragraph) must
  // never reach the persisted/synced spine, or it 400s the whole push batch and wedges all sync.
  return sanitizeBlockIds(blocks);
}

// ── Spine → PM doc ────────────────────────────────────────────────────────────────────────

function segmentsToPmInline(schema: Schema, segments: TextSegment[]): PmNode[] {
  const formulaNode = schema.nodes['formula'];
  return segments.map((seg) => {
    // Inline-formula node: text = the spec. NEW path (seg.formula) + the LEGACY shim (seg.math, the old
    // math MARK) which upgrades to a formula node ftype 'math' on load (no migration; re-saves as a node).
    const asFormula = seg.formula ?? (seg.math ? { type: 'math', state: null } : null);
    if (asFormula && formulaNode && seg.text.length > 0) {
      return formulaNode.create({ ftype: asFormula.type, state: asFormula.state ?? null }, schema.text(seg.text));
    }
    const marks = [
      ...(seg.bold      ? [schema.marks['bold']!.create()]          : []),
      ...(seg.italic    ? [schema.marks['italic']!.create()]        : []),
      ...(seg.code      ? [schema.marks['code']!.create()]          : []),
      ...(seg.underline ? [schema.marks['underline']!.create()]     : []),
      ...(seg.strike    ? [schema.marks['strikethrough']!.create()] : []),
      ...(seg.highlight ? [schema.marks['highlight']!.create()]     : []),
      ...(seg.link      ? [schema.marks['link']!.create({ href: seg.link, title: null })] : []),
    ];
    if (seg.text === '\n') return schema.nodes['hard_break']!.create();
    return schema.text(seg.text, marks);
  });
}

function spineBlockToPmNode(schema: Schema, block: Block): PmNode | PmNode[] | null {
  const id = block.id as string;

  switch (block.type) {
    case 'paragraph': {
      const c = parseParagraphContent(block.content);
      return schema.nodes['paragraph']!.create({ id }, segmentsToPmInline(schema, c.segments));
    }

    case 'heading': {
      const c = parseHeadingContent(block.content);
      return schema.nodes['heading']!.create({ id, level: c.level }, segmentsToPmInline(schema, c.segments));
    }

    case 'quote': {
      const c = parseQuoteContent(block.content);
      const inner: PmNode[] = [];
      // The quote's FIRST paragraph is render-only: pmDocToSpine flattens its segments into the quote
      // content and discards its node id (only the quote's own id + any *extra* children are persisted).
      // A fresh random id here made spineToPmDoc non-deterministic → broke the #90 reconcile echo-guard
      // (incoming.eq(doc)) → wiped the undo stack. Derive it from the persisted quote id so the same spine
      // always serializes to the same doc. `~q` cannot collide with a real UUID (uuids never contain `~`).
      if (c.segments.length > 0) {
        inner.push(schema.nodes['paragraph']!.create(
          { id: `${id}~q` },
          segmentsToPmInline(schema, c.segments),
        ));
      }
      for (const child of block.children ?? []) {
        const converted = spineBlockToPmNode(schema, child);
        if (converted) {
          if (Array.isArray(converted)) inner.push(...converted);
          else inner.push(converted);
        }
      }
      const content = inner.length > 0 ? inner : [schema.nodes['paragraph']!.create({ id: `${id}~q` })];
      return schema.nodes['blockquote']!.create({ id }, content);
    }

    case 'code': {
      const c = parseCodeContent(block.content);
      const textNode = c.code ? [schema.text(c.code)] : [];
      return schema.nodes['code_block']!.create({ id, language: c.language ?? null }, textNode);
    }

    case 'todo': {
      const c = parseTodoContent(block.content);
      return schema.nodes['todo_item']!.create(
        { id, checked: c.checked },
        segmentsToPmInline(schema, c.segments),
      );
    }

    case 'divider':
      return schema.nodes['horizontal_rule']!.create({ id });

    case 'list': {
      const c = parseListContent(block.content);
      const listNodeType = c.ordered ? schema.nodes['ordered_list']! : schema.nodes['bullet_list']!;

      const items: PmNode[] = (block.children ?? []).map((child) => {
        const itemId = child.id as string;
        const nestedLists: PmNode[] = [];
        for (const subChild of child.children ?? []) {
          const nested = spineBlockToPmNode(schema, subChild);
          if (nested) {
            if (Array.isArray(nested)) nestedLists.push(...nested);
            else nestedLists.push(nested);
          }
        }

        // A list_item's INNER paragraph/todo carries no persisted id — pmDocToSpine keys the spine block on
        // the list_item id (itemId) and throws the inner node's id away. Emitting `id: null` (instead of a
        // fresh random) keeps spineToPmDoc deterministic; uniqueBlockIdPlugin is taught to leave these null
        // (it would otherwise re-mint a random one), so the live doc and the round-trip stay byte-identical →
        // the #90 reconcile echo-guard short-circuits instead of replacing the doc + wiping undo history.
        let innerNode: PmNode;
        if (child.type === 'todo') {
          const tc = parseTodoContent(child.content);
          innerNode = schema.nodes['todo_item']!.create(
            { id: null, checked: tc.checked },
            segmentsToPmInline(schema, tc.segments),
          );
        } else {
          const pc = parseParagraphContent(child.content);
          innerNode = schema.nodes['paragraph']!.create(
            { id: null },
            segmentsToPmInline(schema, pc.segments),
          );
        }

        return schema.nodes['list_item']!.create({ id: itemId }, [innerNode, ...nestedLists]);
      });

      if (items.length === 0) {
        items.push(schema.nodes['list_item']!.create(
          { id: `${id}~empty` },
          [schema.nodes['paragraph']!.create({ id: null })],
        ));
      }

      return listNodeType.create({ id }, items);
    }

    default: {
      // Unknown or plugin block: represent as a plugin_block atom. SPIKE (Mechanic A): the atom is now
      // INLINE, so it cannot sit directly in the doc/quote body (which expect blocks) — wrap it in a
      // paragraph. textblockToBlocks() is the exact inverse on the way back (an isolated atom unwraps to the
      // bare plugin block). The synthetic wrapper paragraph gets a fresh id; the atom keeps the spine id.
      const atom = schema.nodes['plugin_block']!.create({
        id,
        pluginType: block.type,
        pluginContent: block.content ?? null,
      });
      // The wrapper paragraph is render-only (textblockToBlocks unwraps an isolated atom back to the bare
      // plugin block, discarding this paragraph's id). Derive it from the atom's persisted id (`~w`) so
      // spineToPmDoc is deterministic — a fresh random here broke the #90 reconcile echo-guard.
      return schema.nodes['paragraph']!.create({ id: `${id}~w` }, [atom]);
    }
  }
}

/**
 * Convert the spine block body to a ProseMirror document node.
 * The title string becomes the first `title` node; the blocks follow as the body.
 */
export function spineToPmDoc(schema: Schema, blocks: BlockBody, title = ''): PmNode {
  // Build title node inline content
  const titleInline = title ? [schema.text(title)] : [];
  const titleNode = schema.nodes['title']!.create({ id: null }, titleInline);

  const bodyNodes: PmNode[] = [];
  for (const block of blocks) {
    const converted = spineBlockToPmNode(schema, block);
    if (converted) {
      if (Array.isArray(converted)) bodyNodes.push(...converted);
      else bodyNodes.push(converted);
    }
  }

  return schema.nodes['doc']!.create(null, [titleNode, ...bodyNodes]);
}
