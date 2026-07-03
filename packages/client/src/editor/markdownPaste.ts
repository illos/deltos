import { Plugin } from 'prosemirror-state';
import { Slice, Fragment } from 'prosemirror-model';
import type { Node as PmNode, ResolvedPos } from 'prosemirror-model';
import { markdownToBody } from '@deltos/shared';
import type { Block } from '@deltos/shared';
import type { DeltoSchema } from './schema.js';
import { spineToPmDoc } from './serializer.js';

/**
 * Plain-text markdown paste (the inverse of the copy serializer, `clipboard.ts` nodeToText). Rich HTML paste
 * already converts to native blocks (schema parseDOM + transformPastedHTML); PLAIN-TEXT paste previously
 * landed as literal characters, so pasting markdown from Claude's chat / a `.md` file / a terminal dropped
 * dead `#`, `- [ ]`, `**bold**` etc. into the note. This handler closes that gap by reusing the SHARED
 * parser (`markdownToBody` → spine `Block[]`) and the EXISTING spine→PM serializer (`spineToPmDoc`) — no
 * second markdown parser and no second spine→PM mapping.
 *
 * Hooked as an editor PLUGIN (via the plugin list), NOT a direct EditorView prop, so it can be ordered
 * AFTER the file/URL paste plugins (attachment image paste, embeds bare-URL card). Direct view props run
 * BEFORE plugin props in ProseMirror's `someProp` order, which would let this steal a file/URL paste. As a
 * trailing plugin it only sees a paste the earlier handlers declined — and it additionally guards against
 * files / a lone URL / the title node so those paths are never regressed even if order changes.
 *
 * It intercepts ONLY when the plain text actually parses to markdown STRUCTURE (a non-paragraph block or a
 * mark-bearing inline segment). Bare prose — and genuine rich-web HTML paste, whose `text/plain` is unmarked
 * prose — falls through to the default paste, so the `transformPastedHTML` + `parseDOM` path keeps its
 * formatting. This deliberately does NOT gate on a `text/html` flavour being present: almost every real copy
 * (from inside deltos, a chat client, a webpage) carries a `text/html` flavour alongside the text, so the
 * old "html present → defer" rule made the markdown converter almost never fire.
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
 * Build the plain-text-markdown paste plugin. MUST be ordered AFTER the file/URL paste plugins (it is added
 * as a trailing base plugin in ProseMirrorEditor.tsx). Returns `false` (default paste) for: no clipboard
 * data, pasted files, empty text, a lone URL, a caret inside the title, or plain text that carries no
 * markdown structure (bare prose / rich-web HTML paste). Guard order is preserved as listed.
 */
export function buildMarkdownPastePlugin(schema: DeltoSchema): Plugin {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const cd = event.clipboardData;
        if (!cd) return false;
        // File / image paste → the attachment plugin owns it (runs earlier). Defensive so a file paste is
        // never swallowed as text.
        if (cd.files && cd.files.length > 0) return false;
        const text = cd.getData('text/plain');
        if (!text || text.length === 0) return false;
        // A lone URL belongs to the embeds card handler, not markdown conversion.
        if (BARE_URL_RE.test(text.trim())) return false;
        // Title node: keep title paste plain text — never inject blocks into the title.
        if (inTitle(view.state.selection.$from)) return false;

        // Structure test (replaces the old "text/html present → defer" rule). Parse the PLAIN TEXT and only
        // intercept when it actually carries markdown structure — a non-paragraph block or a mark-bearing
        // segment. Bare prose (and genuine rich-web HTML paste, whose text/plain is unmarked prose) falls
        // through to ProseMirror's default paste, preserving the transformPastedHTML + parseDOM path. This
        // fires REGARDLESS of whether a `text/html` flavour is present — almost every real copy carries one,
        // which is exactly why gating on HTML presence made the converter almost never fire.
        if (!hasMarkdownStructure(markdownToBody(text))) return false;

        const slice = markdownTextToSlice(schema, text);
        if (!slice) return false;
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
        return true;
      },
    },
  });
}
