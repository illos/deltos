import { Selection } from 'prosemirror-state';
import { Slice, Fragment } from 'prosemirror-model';
import type { Node as PmNode, ResolvedPos } from 'prosemirror-model';
import { markdownToBody } from '@deltos/shared';
import type { Block } from '@deltos/shared';
import type { DeltoSchema } from './schema.js';
import type { BulkTransform } from './inputPipeline/index.js';
import { spineToPmDoc } from './serializer.js';

/**
 * Plain-text markdown paste (the inverse of the copy serializer, `clipboard.ts` nodeToText) — the
 * pipeline's BULK transform ([ROAD-0007] step 4, design §4). Rich HTML paste already converts to native
 * blocks (schema parseDOM + transformPastedHTML); PLAIN-TEXT paste previously landed as literal characters,
 * so pasting markdown from Claude's chat / a `.md` file / a terminal dropped dead `#`, `- [ ]`, `**bold**`
 * etc. into the note. This transform closes that gap by reusing the SHARED parser (`markdownToBody` → spine
 * `Block[]`) and the EXISTING spine→PM serializer (`spineToPmDoc`) — no second markdown parser and no
 * second spine→PM mapping.
 *
 * Delivery is no longer this module's business: prosemirror-view's default paste (desktop ClipboardEvent)
 * and the pipeline plugin's Deck `beforeinput` adapter both land the pasted text in the doc as an ordinary
 * `uiEvent:'paste'` transaction; the pipeline's appendTransaction bulk leg then hands the INSERTED RANGE to
 * this handler. That kills the old `handlePaste` interception and its someProp-ordering constraint — the
 * embeds card / attachment handlers fully own their pastes (they return true and dispatch untagged, so the
 * pipeline never sees them), and this handler cannot steal a file/URL paste by construction.
 *
 * It converts ONLY when the inserted text actually parses to markdown STRUCTURE (a non-paragraph block or a
 * mark-bearing inline segment). Bare prose — and rich-web HTML paste, which arrives already structured and
 * trips the rich-slice guard — stays exactly as the default paste left it.
 */

// A lone URL (the whole trimmed clipboard) belongs to the embeds link-card handler, not markdown
// conversion. Mirrors embeds/index.ts BARE_URL_RE — a defensive skip (embeds runs first anyway).
const BARE_URL_RE = /^https?:\/\/[^\s]+$/i;

// Inline mark keys on a parsed TextSegment (mirrors markdown.ts TextSegment). A segment carrying ANY of
// these is "structural" — the text held real markdown formatting, not bare prose.
const MARK_KEYS = ['bold', 'italic', 'code', 'underline', 'strike', 'highlight', 'link'] as const;

/** True iff a parsed block's content carries a segment with any inline formatting mark. */
function hasMarkedSegment(block: Block): boolean {
  const content = block.content as { segments?: unknown } | undefined;
  const segments = content?.segments;
  if (!Array.isArray(segments)) return false;
  return segments.some(
    (seg) => seg != null && typeof seg === 'object' && MARK_KEYS.some((k) => k in (seg as object)),
  );
}

/**
 * Detect whether the parsed markdown carries real STRUCTURE — i.e. the pasted text was actually markdown,
 * not bare prose. True iff (walking blocks + their children recursively) any block's `type` is not
 * `'paragraph'` (a heading / todo / list / quote / code / divider / …) OR any block carries a segment with
 * an inline formatting mark (bold / italic / code / underline / strike / highlight / link). This is the
 * gate that decides whether the md-paste handler fires: only real markdown is intercepted; plain prose (and
 * genuine rich-web HTML paste) falls through to ProseMirror's default paste.
 */
function hasMarkdownStructure(blocks: Block[]): boolean {
  for (const block of blocks) {
    if (block.type !== 'paragraph') return true;
    if (hasMarkedSegment(block)) return true;
    if (block.children && block.children.length > 0 && hasMarkdownStructure(block.children)) return true;
  }
  return false;
}

/** True iff any ancestor of `$pos` is the unified title node — paste into the title stays plain text. */
function inTitle($pos: ResolvedPos): boolean {
  for (let d = $pos.depth; d >= 0; d--) {
    if ($pos.node(d).type.name === 'title') return true;
  }
  return false;
}

/**
 * Convert markdown text to a PM `Slice` for insertion at the selection. Reuses `markdownToBody` (shared) +
 * `spineToPmDoc` (the existing spine→PM serializer): parse text → spine blocks → a throwaway PM doc, then
 * take its body nodes (dropping the synthetic title). Returns `null` for whitespace-only text (no blocks) so
 * the caller falls through to the default paste.
 *
 * Open-depth heuristic — mirrors PM's default plain-text paste so behaviour is CONSERVATIVE: a leading /
 * trailing PARAGRAPH is left "open" (openStart / openEnd = 1) so its inline content MERGES into the
 * surrounding textblock instead of forcing a fresh block — a single inline snippet pastes inline, with no
 * surprise paragraph split. A leading heading / list / quote / code stays a full (closed) block;
 * `replaceRange` then extends over an empty target paragraph, so pasting a block document into a fresh note
 * leaves no ghost leading paragraph.
 */
export function markdownTextToSlice(schema: DeltoSchema, text: string): Slice | null {
  const blocks = markdownToBody(text);
  if (blocks.length === 0) return null;
  // spineToPmDoc emits `doc(title, ...body)`; take the body nodes (index 0 is the synthetic empty title).
  const doc = spineToPmDoc(schema, blocks, '');
  const body: PmNode[] = [];
  doc.forEach((node, _offset, index) => { if (index > 0) body.push(node); });
  if (body.length === 0) return null;
  const first = body[0]!;
  const last = body[body.length - 1]!;
  const openStart = first.type.name === 'paragraph' ? 1 : 0;
  const openEnd = last.type.name === 'paragraph' ? 1 : 0;
  return new Slice(Fragment.fromArray(body), openStart, openEnd);
}

/**
 * True iff the inserted range holds anything OTHER than plain unmarked paragraphs — i.e. the paste arrived
 * already STRUCTURED (a rich HTML paste via parseDOM/transformPastedHTML, or PM inherited context marks at
 * the insertion point). Structured input must never be re-parsed as markdown (design §4 rich-paste guard).
 */
function rangeIsRich(state: Parameters<BulkTransform['handler']>[0], from: number, to: number): boolean {
  let rich = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (rich) return false;
    if (node.isText) {
      if (node.marks.length > 0) rich = true;
      return false;
    }
    if (node.type.name !== 'paragraph') rich = true;
    return !rich;
  });
  return rich;
}

/**
 * The markdown BULK transform (registered in editorTransforms.ts; invoked by the pipeline's
 * appendTransaction leg on qualifying paste transactions ONLY — the §2.2 gate has already run).
 * `from`/`to` bound the freshly inserted content. Skip (null) for: an insertion into the title (title
 * paste stays plain), into a code block (pasted markdown stays literal there), an already-structured
 * insertion (rich guard above), a lone bare URL (the embeds card owns it), or text with no markdown
 * structure. On conversion: replace the inserted range with the parsed blocks (open-depth heuristic in
 * `markdownTextToSlice` preserved) and put the caret at the end of the replacement.
 */
export function markdownPasteBulk(schema: DeltoSchema): BulkTransform {
  return {
    id: 'md-paste',
    handler(state, from, to) {
      const $from = state.doc.resolve(from);
      // Title node: keep title paste plain text — never inject blocks into the title.
      if (inTitle($from)) return null;
      // Code block: pasting markdown INTO code stays literal (PM already inserted it as raw text).
      if ($from.parent.type.spec.code) return null;
      if (rangeIsRich(state, from, to)) return null;
      // '\n' block separator mirrors the line-per-paragraph shape PM's plain-text paste produced; the
      // shared parser is line-based (one block per line), so this round-trips the clipboard lines.
      const text = state.doc.textBetween(from, to, '\n');
      if (!text || text.length === 0) return null;
      // A lone URL belongs to the embeds card handler, not markdown conversion.
      if (BARE_URL_RE.test(text.trim())) return null;
      // Structure test: only convert when the text actually carries markdown structure — a non-paragraph
      // block or a mark-bearing segment. Bare prose stays exactly as the default paste left it.
      if (!hasMarkdownStructure(markdownToBody(text))) return null;
      const slice = markdownTextToSlice(schema, text);
      if (!slice) return null;
      const tr = state.tr.replaceRange(from, to, slice);
      const end = Math.min(tr.mapping.map(to, -1), tr.doc.content.size);
      return tr.setSelection(Selection.near(tr.doc.resolve(end), -1)).scrollIntoView();
    },
  };
}
