import type { Node as PmNode, Schema } from 'prosemirror-model';
import type { Block, BlockBody, BlockId } from '@deltos/shared';
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
  math?: true;        // NEW — inline-math expression (the marked text is the persisted source of truth)
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

function inlineToSegments(node: PmNode): TextSegment[] {
  const segments: TextSegment[] = [];
  node.forEach((child) => {
    if (child.type.name === 'hard_break') {
      segments.push({ text: '\n' });
      return;
    }
    if (child.type.name !== 'text') return;
    const seg: TextSegment = { text: child.text ?? '' };
    if (child.marks.some((m) => m.type.name === 'bold'))          seg.bold      = true;
    if (child.marks.some((m) => m.type.name === 'italic'))        seg.italic    = true;
    if (child.marks.some((m) => m.type.name === 'code'))          seg.code      = true;
    if (child.marks.some((m) => m.type.name === 'underline'))     seg.underline = true;
    if (child.marks.some((m) => m.type.name === 'strikethrough')) seg.strike    = true;
    if (child.marks.some((m) => m.type.name === 'highlight'))     seg.highlight = true;
    if (child.marks.some((m) => m.type.name === 'math'))          seg.math      = true;
    const linkMark = child.marks.find((m) => m.type.name === 'link');
    if (linkMark) seg.link = linkMark.attrs.href as string;
    segments.push(seg);
  });
  return segments;
}

function pmNodeToBlock(node: PmNode): Block | Block[] | null {
  const id = (node.attrs.id as string | null) ?? (newBlockId() as string);

  switch (node.type.name) {
    case 'paragraph': {
      const content: ParagraphContent = { segments: inlineToSegments(node) };
      return { id: id as BlockId, type: 'paragraph', content };
    }

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
  return blocks;
}

// ── Spine → PM doc ────────────────────────────────────────────────────────────────────────

function segmentsToPmInline(schema: Schema, segments: TextSegment[]): PmNode[] {
  return segments.map((seg) => {
    const marks = [
      ...(seg.bold      ? [schema.marks['bold']!.create()]          : []),
      ...(seg.italic    ? [schema.marks['italic']!.create()]        : []),
      ...(seg.code      ? [schema.marks['code']!.create()]          : []),
      ...(seg.underline ? [schema.marks['underline']!.create()]     : []),
      ...(seg.strike    ? [schema.marks['strikethrough']!.create()] : []),
      ...(seg.highlight ? [schema.marks['highlight']!.create()]     : []),
      ...(seg.math      ? [schema.marks['math']!.create()]          : []),
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
      if (c.segments.length > 0) {
        inner.push(schema.nodes['paragraph']!.create(
          { id: newBlockId() as string },
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
      const content = inner.length > 0 ? inner : [schema.nodes['paragraph']!.create({ id: newBlockId() as string })];
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

        let innerNode: PmNode;
        if (child.type === 'todo') {
          const tc = parseTodoContent(child.content);
          innerNode = schema.nodes['todo_item']!.create(
            { id: newBlockId() as string, checked: tc.checked },
            segmentsToPmInline(schema, tc.segments),
          );
        } else {
          const pc = parseParagraphContent(child.content);
          innerNode = schema.nodes['paragraph']!.create(
            { id: newBlockId() as string },
            segmentsToPmInline(schema, pc.segments),
          );
        }

        return schema.nodes['list_item']!.create({ id: itemId }, [innerNode, ...nestedLists]);
      });

      if (items.length === 0) {
        items.push(schema.nodes['list_item']!.create(
          { id: newBlockId() as string },
          [schema.nodes['paragraph']!.create({ id: newBlockId() as string })],
        ));
      }

      return listNodeType.create({ id }, items);
    }

    default:
      // Unknown or plugin block: represent as plugin_block atom.
      return schema.nodes['plugin_block']!.create({
        id,
        pluginType: block.type,
        pluginContent: block.content ?? null,
      });
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
