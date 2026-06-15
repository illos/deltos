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
    if (child.marks.some((m) => m.type.name === 'bold'))   seg.bold   = true;
    if (child.marks.some((m) => m.type.name === 'italic')) seg.italic = true;
    if (child.marks.some((m) => m.type.name === 'code'))   seg.code   = true;
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

/** Convert the ProseMirror document to the spine block body. */
export function pmDocToSpine(doc: PmNode): BlockBody {
  const blocks: Block[] = [];
  doc.forEach((node) => {
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
      ...(seg.bold   ? [schema.marks['bold']!.create()]   : []),
      ...(seg.italic ? [schema.marks['italic']!.create()] : []),
      ...(seg.code   ? [schema.marks['code']!.create()]   : []),
      ...(seg.link   ? [schema.marks['link']!.create({ href: seg.link, title: null })] : []),
    ];
    if (seg.text === '\n') return schema.nodes['hard_break']!.create();
    return schema.text(seg.text, marks);
  });
}

function spineBlockToPmNode(schema: Schema, block: Block): PmNode | PmNode[] | null {
  const id = block.id as string;

  switch (block.type) {
    case 'paragraph': {
      const c = block.content as ParagraphContent | undefined;
      const inline = c ? segmentsToPmInline(schema, c.segments) : [];
      return schema.nodes['paragraph']!.create({ id }, inline);
    }

    case 'heading': {
      const c = block.content as HeadingContent | undefined;
      const inline = c ? segmentsToPmInline(schema, c.segments) : [];
      return schema.nodes['heading']!.create({ id, level: c?.level ?? 1 }, inline);
    }

    case 'quote': {
      const c = block.content as QuoteContent | undefined;
      const inner: PmNode[] = [];
      if (c && c.segments.length > 0) {
        const freshId = newBlockId() as string;
        inner.push(schema.nodes['paragraph']!.create({ id: freshId }, segmentsToPmInline(schema, c.segments)));
      }
      for (const child of block.children ?? []) {
        const converted = spineBlockToPmNode(schema, child);
        if (converted) {
          if (Array.isArray(converted)) inner.push(...converted);
          else inner.push(converted);
        }
      }
      // blockquote requires at least one block child
      const content = inner.length > 0 ? inner : [schema.nodes['paragraph']!.create({ id: newBlockId() as string })];
      return schema.nodes['blockquote']!.create({ id }, content);
    }

    case 'code': {
      const c = block.content as CodeContent | undefined;
      const textNode = c?.code ? [schema.text(c.code)] : [];
      return schema.nodes['code_block']!.create({ id, language: c?.language ?? null }, textNode);
    }

    case 'todo': {
      const c = block.content as TodoContent | undefined;
      const inline = c ? segmentsToPmInline(schema, c.segments) : [];
      return schema.nodes['todo_item']!.create({ id, checked: c?.checked ?? false }, inline);
    }

    case 'divider':
      return schema.nodes['horizontal_rule']!.create({ id });

    case 'list': {
      const c = block.content as ListContent | undefined;
      const ordered = c?.ordered ?? false;
      const listNodeType = ordered ? schema.nodes['ordered_list']! : schema.nodes['bullet_list']!;

      const items: PmNode[] = (block.children ?? []).map((child) => {
        const itemId = child.id as string;
        // Nested list children become list items with nested lists
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
          const tc = child.content as TodoContent | undefined;
          const inline = tc ? segmentsToPmInline(schema, tc.segments) : [];
          innerNode = schema.nodes['todo_item']!.create(
            { id: newBlockId() as string, checked: tc?.checked ?? false },
            inline,
          );
        } else {
          // paragraph (or unknown → paragraph fallback)
          const pc = child.content as ParagraphContent | undefined;
          const inline = pc ? segmentsToPmInline(schema, pc.segments) : [];
          innerNode = schema.nodes['paragraph']!.create({ id: newBlockId() as string }, inline);
        }

        return schema.nodes['list_item']!.create({ id: itemId }, [innerNode, ...nestedLists]);
      });

      // list requires at least one list_item
      if (items.length === 0) {
        items.push(
          schema.nodes['list_item']!.create(
            { id: newBlockId() as string },
            [schema.nodes['paragraph']!.create({ id: newBlockId() as string })],
          ),
        );
      }

      return listNodeType.create({ id }, items);
    }

    default:
      // Unknown or plugin block: represent as plugin_block atom
      return schema.nodes['plugin_block']!.create({
        id,
        pluginType: block.type,
        pluginContent: block.content ?? null,
      });
  }
}

/** Convert the spine block body to a ProseMirror document node. */
export function spineToPmDoc(schema: Schema, blocks: BlockBody): PmNode {
  const nodes: PmNode[] = [];
  for (const block of blocks) {
    const converted = spineBlockToPmNode(schema, block);
    if (converted) {
      if (Array.isArray(converted)) nodes.push(...converted);
      else nodes.push(converted);
    }
  }
  // doc must have at least one block
  if (nodes.length === 0) {
    nodes.push(schema.nodes['paragraph']!.create({ id: null }));
  }
  return schema.nodes['doc']!.create(null, nodes);
}
