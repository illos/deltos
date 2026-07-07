import type { Block } from './block.js';
import { ATTACHMENT_PLUGIN_TYPE, type AttachmentContent } from './attachmentBlock.js';

/**
 * spineToMarkdown — the OUTBOUND `Block[] → markdown string` emitter behind ROAD-0017 "Export as Markdown".
 * It is the MIRROR of {@link markdownToBody} (the inbound parse) and the sibling of {@link spineToHtml} (the
 * HTML render): same `Block[]`, a different emitter (CONV-0004). Pure + deterministic, no side effects, no
 * client/worker imports — so it lives in @deltos/shared and BOTH the client export UI and any future
 * server-side export can call it.
 *
 * Emission conventions are LOCKED to the client's copy serializer (client/src/editor/clipboard.ts
 * `nodeToText`) so a copied note and an exported note produce identical markdown, and so the pair
 * `markdownToBody(spineToMarkdown(x))` round-trips for the core block types + inline marks.
 *
 * Round-trip note: {@link markdownToBody} is deliberately conservative (emphasis delimiters need a
 * non-space neighbour; block markers are line-anchored) and does NOT unescape backslashes. So this emitter
 * does NOT backslash-escape inline text — that would strand a literal `\*` on the return trip. It escapes
 * only where a plain PARAGRAPH would otherwise be swallowed as a structural block on re-parse (a leading
 * `#`, `-`, `>`, fence, etc.), which keeps exported markdown correct in external viewers too.
 *
 * Attachments resolve their URL through the injected {@link SpineMarkdownOptions.attachmentUrl} — the client
 * export path points it at the note's own blob object-URL. Absent/unresolved ⇒ the bare filename (never a
 * dead link). Formula/compute inline atoms carry only their SOURCE spec in the spine (the value is recomputed,
 * never stored — serializer.ts), so — matching {@link spineToHtml} — the source text is emitted verbatim.
 */

export interface SpineMarkdownOptions {
  /** Prepend this as a leading `# {title}` heading (blank/whitespace-only ⇒ omitted). */
  title?: string;
  /**
   * Resolve an attachment block to a URL (image src / link href). The client export path passes the note's
   * blob object-URL resolver; omitted / returns null ⇒ the attachment emits as its bare filename text.
   */
  attachmentUrl?: (att: AttachmentContent) => string | null;
}

// ── inline segments ────────────────────────────────────────────────────────────────────────────

interface Seg {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  underline?: boolean;
  strike?: boolean;
  highlight?: boolean;
  formula?: boolean;
  link?: string;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function parseSegments(raw: unknown): Seg[] {
  if (!Array.isArray(raw)) return [];
  const out: Seg[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item['text'] !== 'string' || item['text'].length === 0) continue;
    const seg: Seg = { text: item['text'] };
    if (item['bold'] === true) seg.bold = true;
    if (item['italic'] === true) seg.italic = true;
    if (item['code'] === true) seg.code = true;
    if (item['underline'] === true) seg.underline = true;
    if (item['strike'] === true) seg.strike = true;
    if (item['highlight'] === true) seg.highlight = true;
    // A formula/compute inline atom (or the legacy math mark): emit its SOURCE spec verbatim (value not stored).
    if (isRecord(item['formula']) || item['math'] === true) seg.formula = true;
    if (typeof item['link'] === 'string') seg.link = item['link'];
    out.push(seg);
  }
  return out;
}

/**
 * Wrap one segment's text in markdown marks. Order mirrors clipboard.ts `inlineText` EXACTLY (innermost →
 * outermost: code, bold, italic, strike, highlight, underline, then link outermost) so a copied and an
 * exported note are byte-identical and single-mark segments round-trip through markdownToBody. A formula
 * atom is emitted as its raw source text (no wrapping). A hard-break segment (`\n`) passes through.
 */
function renderSegment(seg: Seg): string {
  if (seg.formula) return seg.text; // source spec, verbatim (matches spineToHtml)
  let text = seg.text;
  if (seg.code) text = '`' + text + '`';
  if (seg.bold) text = '**' + text + '**';
  if (seg.italic) text = '*' + text + '*';
  if (seg.strike) text = '~~' + text + '~~';
  if (seg.highlight) text = '==' + text + '==';
  if (seg.underline) text = '<u>' + text + '</u>'; // no MD equivalent — HTML span (round-trips nodeToText)
  if (seg.link !== undefined) text = '[' + text + '](' + seg.link + ')';
  return text;
}

function renderInline(rawSegments: unknown): string {
  return parseSegments(rawSegments).map(renderSegment).join('');
}

// ── block-level content readers (defensive; content is `unknown`) ────────────────────────────────

function segmentsOf(content: unknown): unknown {
  return isRecord(content) ? content['segments'] : undefined;
}

function headingLevel(content: unknown): number {
  const lvl = isRecord(content) ? content['level'] : undefined;
  return lvl === 2 || lvl === 3 || lvl === 4 || lvl === 5 || lvl === 6 ? lvl : 1;
}

/** A paragraph whose text would be swallowed as a structural block on re-parse gets its leading marker escaped. */
const LEADING_BLOCK_MARKER = /^(\s*)(#{1,6}\s|>\s?|[-*]\s|\d+\.\s|```|---|\[( |x|X|)\]\s)/;
function escapeLeadingMarker(line: string): string {
  return line.replace(LEADING_BLOCK_MARKER, (_m, ws: string, marker: string) => `${ws}\\${marker}`);
}

// ── block rendering ──────────────────────────────────────────────────────────────────────────────

/** `[x] `/`[ ] ` prefix for a todo block. */
function todoMarker(block: Block): string {
  const checked = isRecord(block.content) && block.content['checked'] === true;
  return checked ? '[x] ' : '[ ] ';
}

function renderAttachment(block: Block, opts: SpineMarkdownOptions): string {
  const c = block.content;
  if (!isRecord(c) || typeof c['hash'] !== 'string' || typeof c['name'] !== 'string') return '[attachment]';
  const att: AttachmentContent = {
    hash: c['hash'],
    name: c['name'],
    mime: typeof c['mime'] === 'string' ? c['mime'] : 'application/octet-stream',
    size: typeof c['size'] === 'number' ? c['size'] : 0,
  };
  const url = opts.attachmentUrl ? opts.attachmentUrl(att) : null;
  if (!url) return att.name; // no resolver ⇒ inert filename, never a dead link (mirrors spineToHtml)
  return att.mime.startsWith('image/') ? `![${att.name}](${url})` : `[${att.name}](${url})`;
}

/**
 * Render a list's item lines (each a bullet/number + inline text, nested sublists indented 2 spaces). One line
 * per item so the whole list is ONE contiguous run markdownToBody re-collapses into a single list block.
 */
function renderListLines(list: Block, indent: string, opts: SpineMarkdownOptions): string[] {
  const ordered = isRecord(list.content) && list.content['ordered'] === true;
  const lines: string[] = [];
  let n = 1;
  for (const item of list.children ?? []) {
    const marker = ordered ? `${n}. ` : '- ';
    const todo = item.type === 'todo' ? todoMarker(item) : '';
    lines.push(indent + marker + todo + renderInline(segmentsOf(item.content)));
    n += 1;
    for (const child of item.children ?? []) {
      if (child.type === 'list') lines.push(...renderListLines(child, indent + '  ', opts));
    }
  }
  return lines;
}

/** Render ONE block to a markdown chunk (blocks are later joined by blank lines). */
function renderBlock(block: Block, opts: SpineMarkdownOptions): string {
  switch (block.type) {
    case 'heading':
      return '#'.repeat(headingLevel(block.content)) + ' ' + renderInline(segmentsOf(block.content));
    case 'paragraph':
      return escapeLeadingMarker(renderInline(segmentsOf(block.content)));
    case 'quote': {
      const first = renderInline(segmentsOf(block.content));
      const rest = (block.children ?? []).map((c) => renderInline(segmentsOf(c.content)));
      return [first, ...rest].map((l) => '> ' + l).join('\n');
    }
    case 'code': {
      const code = isRecord(block.content) && typeof block.content['code'] === 'string' ? block.content['code'] : '';
      const lang = isRecord(block.content) && typeof block.content['language'] === 'string' ? block.content['language'] : '';
      return '```' + lang + '\n' + code + '\n```';
    }
    case 'todo':
      return todoMarker(block) + renderInline(segmentsOf(block.content));
    case 'divider':
      return '---';
    case 'list':
      return renderListLines(block, '', opts).join('\n');
    case ATTACHMENT_PLUGIN_TYPE:
      return renderAttachment(block, opts);
    default:
      // Unknown / plugin block with no dedicated emitter: emit its inline segments if it carries any
      // (a text-bearing variant), else nothing — never leak an opaque payload (mirrors spineToHtml default).
      return renderInline(segmentsOf(block.content));
  }
}

/**
 * Serialize a spine block body to a markdown string. Top-level blocks render in order and are joined by a
 * blank line (the paragraph separator markdownToBody expects); a list/quote is emitted as one contiguous
 * multi-line chunk so it re-collapses to a single block. A `title` is prepended as a leading `# {title}`.
 * Empty blocks (an unknown block with no segments) are dropped so no stray blank lines appear.
 */
export function spineToMarkdown(blocks: Block[], opts: SpineMarkdownOptions = {}): string {
  const chunks = blocks.map((b) => renderBlock(b, opts)).filter((c) => c.length > 0);
  const title = opts.title?.trim();
  if (title) chunks.unshift('# ' + title);
  return chunks.join('\n\n');
}
