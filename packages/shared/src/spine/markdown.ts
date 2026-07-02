import { BlockIdSchema } from './ids.js';
import type { BlockId } from './ids.js';
import type { Block } from './block.js';

/**
 * markdownToBody — parse agent-authored markdown into native spine blocks.
 *
 * This is the INVERSE of the client's copy serializer (`client/src/editor/clipboard.ts` `nodeToText`,
 * which EMITS markdown from the spine) plus the editor's inline input-rule marks
 * (`client/src/editor/inputRules.ts`). When an agent creates/updates a note over MCP its body arrives as
 * text; the old path stored it as literal plaintext, so `[ ] task`, `# heading`, `**bold**`, `> quote`,
 * ```` ``` ````, `---` rendered as dead characters (deltos stores the SPINE, and the editor's input rules
 * only fire on live typing — MCP-inserted markdown never converts). This parser closes that gap.
 *
 * Design constraints:
 *  - Hand-rolled, dependency-light, PURE (no worker/client imports) — a follow-up client workstream reuses
 *    it for editor plain-text PASTE, so it lives in @deltos/shared with zero side effects.
 *  - A SUPERSET of the old plain-text path: plain prose with no markdown still yields paragraph blocks
 *    (one per non-blank line), so there is no regression for agents that just write prose.
 *  - Conservative: only line-anchored block syntax converts; casual prose (`2 * 3 * 4`) is left intact.
 *  - Block ids are SERVER-MINTED UUIDs (via BlockIdSchema.parse) — a non-UUID block id 400s the entire
 *    sync push batch (a known prod landmine), so every emitted id is a real UUID, never a render-only id.
 *
 * The emitted shapes mirror `client/src/editor/serializer.ts` (fromSpine) exactly:
 *   paragraph { segments }        heading { level, segments }     quote { segments } (+ children)
 *   code { code, language? }      todo { checked, segments }      list { ordered } (children = items)
 *   divider (no content)
 * A list is a `type:'list'` block whose `children[]` are the item blocks (each a `paragraph`, or a `todo`
 * for `- [ ]`); a nested list becomes a `type:'list'` child of its parent item block.
 */

// ── inline rich-text segment (mirrors serializer.ts TextSegment) ─────────────────────────────
export interface TextSegment {
  text: string;
  bold?: true;
  italic?: true;
  code?: true;
  underline?: true;
  strike?: true;
  highlight?: true;
  link?: string; // href
}

// Per-block content shapes (mirror serializer.ts). Kept local so the parser is a self-contained export.
interface ParagraphContent { segments: TextSegment[] }
interface HeadingContent { level: 1 | 2 | 3 | 4 | 5 | 6; segments: TextSegment[] }
interface QuoteContent { segments: TextSegment[] }
interface CodeContent { code: string; language?: string }
interface TodoContent { checked: boolean; segments: TextSegment[] }
interface ListContent { ordered: boolean }

/**
 * `crypto.randomUUID()` via `globalThis` — the shared package builds against ES2022 (no DOM/Worker lib) so
 * `crypto` isn't typed here, but it exists on every runtime target (browser, Workers, Node ≥19). Mirrors
 * the discipline in attachmentBlock.ts / the client's `newBlockId()` without a lib change.
 */
const randomUuid = (): string =>
  (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();

/** Mint a fresh, branded spine block id (a real UUID — never a deterministic/render-only id). */
const newBlockId = (): BlockId => BlockIdSchema.parse(randomUuid()) as BlockId;

// ── inline mark tokenizer ────────────────────────────────────────────────────────────────────
//
// Active marks accumulate down the recursion (a `**bold `code`**` run yields a bold+code segment). The
// scan finds the EARLIEST construct at each step, emits the preceding plain run, handles the construct
// (recursing into its inner text so marks nest), then continues after it. Emphasis delimiters require a
// non-space character adjacent to the delimiter so casual prose (`2 * 3 * 4`, `a -- b`) is not transformed.

interface Flags {
  bold?: true;
  italic?: true;
  code?: true;
  underline?: true;
  strike?: true;
  highlight?: true;
  link?: string;
}

function segFrom(text: string, flags: Flags): TextSegment {
  const seg: TextSegment = { text };
  if (flags.bold) seg.bold = true;
  if (flags.italic) seg.italic = true;
  if (flags.code) seg.code = true;
  if (flags.underline) seg.underline = true;
  if (flags.strike) seg.strike = true;
  if (flags.highlight) seg.highlight = true;
  if (flags.link) seg.link = flags.link;
  return seg;
}

// Emphasis: `(?!\s)…(?<!\s)` keeps a space off either delimiter so `2 * 3 * 4` and `a ~~ b` stay literal.
const CODE_RE = /`([^`\n]+)`/;
const LINK_RE = /\[([^\]]*)\]\(([^()\s]+)\)/;
const BOLD_RE = /\*\*(?!\s)([^*]+?)(?<!\s)\*\*/;
const UNDERLINE_RE = /<u>([\s\S]+?)<\/u>/;
const STRIKE_RE = /~~(?!\s)([^~]+?)(?<!\s)~~/;
const HIGHLIGHT_RE = /==(?!\s)([^=]+?)(?<!\s)==/;
const ITALIC_RE = /\*(?!\s)([^*]+?)(?<!\s)\*/;
const BARE_URL_RE = /https?:\/\/[^\s<>()]+/;

/** A regex capture group as a definite string ('' if absent) — the RE guarantees the group under strict indexing. */
const grp = (m: RegExpExecArray, i: number): string => m[i] ?? '';

function parseInlineFlags(text: string, flags: Flags): TextSegment[] {
  if (text.length === 0) return [];

  let best: { index: number; end: number; segs: TextSegment[] } | null = null;
  const consider = (m: RegExpExecArray, segs: TextSegment[]) => {
    if (best === null || m.index < best.index) best = { index: m.index, end: m.index + grp(m, 0).length, segs };
  };

  // Order matters only for ties on the SAME index; code/link are structural and take precedence, bold
  // before italic so `**` is never eaten by the single-`*` rule.
  const code = CODE_RE.exec(text); // code is literal — no inner mark parsing
  if (code) consider(code, [segFrom(grp(code, 1), { ...flags, code: true })]);

  const link = LINK_RE.exec(text);
  if (link) {
    const href = grp(link, 2);
    const inner = grp(link, 1).length > 0
      ? parseInlineFlags(grp(link, 1), { ...flags, link: href })
      : [segFrom(href, { ...flags, link: href })];
    consider(link, inner);
  }

  const bold = BOLD_RE.exec(text);
  if (bold) consider(bold, parseInlineFlags(grp(bold, 1), { ...flags, bold: true }));

  const underline = UNDERLINE_RE.exec(text);
  if (underline) consider(underline, parseInlineFlags(grp(underline, 1), { ...flags, underline: true }));

  const strike = STRIKE_RE.exec(text);
  if (strike) consider(strike, parseInlineFlags(grp(strike, 1), { ...flags, strike: true }));

  const highlight = HIGHLIGHT_RE.exec(text);
  if (highlight) consider(highlight, parseInlineFlags(grp(highlight, 1), { ...flags, highlight: true }));

  const italic = ITALIC_RE.exec(text);
  if (italic) consider(italic, parseInlineFlags(grp(italic, 1), { ...flags, italic: true }));

  const url = BARE_URL_RE.exec(text);
  if (url) consider(url, [segFrom(grp(url, 0), { ...flags, link: grp(url, 0) })]);

  if (best === null) return [segFrom(text, flags)];
  const hit: { index: number; end: number; segs: TextSegment[] } = best;

  const out: TextSegment[] = [];
  if (hit.index > 0) out.push(segFrom(text.slice(0, hit.index), flags));
  out.push(...hit.segs);
  out.push(...parseInlineFlags(text.slice(hit.end), flags));
  return out.filter((s) => s.text.length > 0);
}

/** Parse a single line of inline markdown into rich-text segments (empty line → no segments). */
function parseInline(text: string): TextSegment[] {
  return parseInlineFlags(text, {});
}

// ── block-level line grammar ──────────────────────────────────────────────────────────────────

const FENCE_RE = /^```(.*)$/;
const FENCE_CLOSE_RE = /^```\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const DIVIDER_RE = /^---$/;
const QUOTE_RE = /^>\s?/;
const TODO_RE = /^\[( |x|X|)\]\s+(.*)$/;
const LIST_ITEM_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

/** Build a todo or paragraph block from a line's remaining content (after any list marker). */
function contentBlock(content: string): Block {
  const todo = TODO_RE.exec(content);
  if (todo) {
    const flag = grp(todo, 1);
    const c: TodoContent = { checked: flag === 'x' || flag === 'X', segments: parseInline(grp(todo, 2)) };
    return { id: newBlockId(), type: 'todo', content: c };
  }
  const c: ParagraphContent = { segments: parseInline(content) };
  return { id: newBlockId(), type: 'paragraph', content: c };
}

interface ParsedItem { indent: number; ordered: boolean; block: Block }

function parseListItem(line: string): ParsedItem {
  const m = LIST_ITEM_RE.exec(line);
  if (!m) return { indent: 0, ordered: false, block: contentBlock(line) };
  return { indent: grp(m, 1).length, ordered: /\d/.test(grp(m, 2)), block: contentBlock(grp(m, 3)) };
}

/**
 * Build the list block(s) for the items at `indent`, recursing on deeper-indented runs (attached as a
 * nested list child of the preceding item). A change of ordered-ness at the same indent starts a new
 * sibling list — mirroring the editor, where a bullet run and an ordered run are distinct list nodes.
 */
function buildLevel(items: ParsedItem[], start: number, indent: number): { lists: Block[]; next: number } {
  const lists: Block[] = [];
  let i = start;
  let currentList: Block | null = null;
  let currentOrdered: boolean | null = null;
  let lastItem: Block | null = null;

  for (let it = items[i]; it !== undefined && it.indent >= indent; it = items[i]) {
    if (it.indent > indent) {
      // A deeper run belongs to the previous item as a nested list; if there is no parent (malformed
      // leading indent) treat it as a sibling at its own indent so we never loop.
      const nested = buildLevel(items, i, it.indent);
      if (lastItem) lastItem.children = [...(lastItem.children ?? []), ...nested.lists];
      else lists.push(...nested.lists);
      i = nested.next;
      continue;
    }
    if (currentList === null || currentOrdered !== it.ordered) {
      const content: ListContent = { ordered: it.ordered };
      currentList = { id: newBlockId(), type: 'list', content, children: [] };
      currentOrdered = it.ordered;
      lists.push(currentList);
    }
    currentList.children!.push(it.block);
    lastItem = it.block;
    i++;
  }
  return { lists, next: i };
}

/**
 * Parse markdown into a spine block body. Line-anchored block syntax (headings, todos, lists, blockquotes,
 * fenced code, dividers) converts to native blocks; everything else is prose — one paragraph per non-blank
 * line (the old plain-text behaviour, preserved). Blank lines separate blocks (no empty ghost paragraphs).
 */
export function markdownToBody(md: string): Block[] {
  const lines = md.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  for (let line = lines[i]; line !== undefined; line = lines[i]) {
    // Blank line — a separator between blocks.
    if (line.trim().length === 0) { i++; continue; }

    // Fenced code — raw text, NO inline/block parsing inside (mirrors nodeToText code_block).
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const language = grp(fence, 1).trim();
      const codeLines: string[] = [];
      i++;
      for (let l = lines[i]; l !== undefined && !FENCE_CLOSE_RE.test(l); l = lines[i]) { codeLines.push(l); i++; }
      if (i < lines.length) i++; // consume the closing ```
      const content: CodeContent = { code: codeLines.join('\n') };
      if (language) content.language = language;
      blocks.push({ id: newBlockId(), type: 'code', content });
      continue;
    }

    // Divider.
    if (DIVIDER_RE.test(line)) { blocks.push({ id: newBlockId(), type: 'divider' }); i++; continue; }

    // Heading (# .. ######, space required, 7+ hashes fall through to a paragraph).
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const content: HeadingContent = { level: grp(heading, 1).length as 1 | 2 | 3 | 4 | 5 | 6, segments: parseInline(grp(heading, 2)) };
      blocks.push({ id: newBlockId(), type: 'heading', content });
      i++;
      continue;
    }

    // Blockquote — collapse consecutive `> ` lines into ONE quote block (first line = content, rest =
    // child paragraphs), mirroring serializer.ts (first paragraph flattened into content, extras = children).
    if (QUOTE_RE.test(line)) {
      const qLines: string[] = [];
      for (let l = lines[i]; l !== undefined && QUOTE_RE.test(l); l = lines[i]) { qLines.push(l.replace(QUOTE_RE, '')); i++; }
      const content: QuoteContent = { segments: parseInline(qLines[0] ?? '') };
      const block: Block = { id: newBlockId(), type: 'quote', content };
      const children = qLines.slice(1)
        .filter((l) => l.length > 0)
        .map((l): Block => ({ id: newBlockId(), type: 'paragraph', content: { segments: parseInline(l) } satisfies ParagraphContent }));
      if (children.length > 0) block.children = children;
      blocks.push(block);
      continue;
    }

    // Top-level todo (`[ ] …` / `[x] …`) NOT part of a list.
    const todo = TODO_RE.exec(line);
    if (todo) {
      const flag = grp(todo, 1);
      const content: TodoContent = { checked: flag === 'x' || flag === 'X', segments: parseInline(grp(todo, 2)) };
      blocks.push({ id: newBlockId(), type: 'todo', content });
      i++;
      continue;
    }

    // List — a run of consecutive list-item lines (bullets/ordered, nested by indentation).
    if (LIST_ITEM_RE.test(line)) {
      const items: ParsedItem[] = [];
      for (let l = lines[i]; l !== undefined && LIST_ITEM_RE.test(l); l = lines[i]) { items.push(parseListItem(l)); i++; }
      const { lists } = buildLevel(items, 0, items[0]?.indent ?? 0);
      blocks.push(...lists);
      continue;
    }

    // Prose — one paragraph per non-blank line (the old plain-text path, unchanged).
    blocks.push({ id: newBlockId(), type: 'paragraph', content: { segments: parseInline(line) } satisfies ParagraphContent });
    i++;
  }

  return blocks;
}

/**
 * Strip a leading markdown heading marker (`#`..`######` + space) from a note TITLE. Titles are plain text;
 * agents sometimes send a markdown heading as the title (the real bug where a title was literally
 * `# 2005 Jetta…`). Only the leading marker is removed; the rest of the title is left verbatim.
 */
export function stripTitleMarkdown(title: string): string {
  return title.replace(/^#{1,6}\s+/, '');
}
