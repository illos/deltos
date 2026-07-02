import { Plugin } from 'prosemirror-state';
import { Slice, Fragment } from 'prosemirror-model';
import type { Node as PmNode, ResolvedPos } from 'prosemirror-model';
import { markdownToBody } from '@deltos/shared';
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
 * files / a lone URL / a rich `text/html` flavour so those paths are never regressed even if order changes.
 */

// A lone URL (the whole trimmed clipboard) belongs to the embeds link-card handler, not markdown
// conversion. Mirrors embeds/index.ts BARE_URL_RE — a defensive skip (embeds runs first anyway).
const BARE_URL_RE = /^https?:\/\/[^\s]+$/i;

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
 * data, pasted files, a rich `text/html` flavour, empty text, a lone URL, or a caret inside the title.
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
        // Rich paste: a useful `text/html` flavour → leave the existing transformPastedHTML + parseDOM path
        // untouched (return false = default paste). Only a PLAIN-TEXT-ONLY clipboard is markdown-converted.
        const html = cd.getData('text/html');
        if (html && html.trim().length > 0) return false;
        const text = cd.getData('text/plain');
        if (!text || text.length === 0) return false;
        // A lone URL belongs to the embeds card handler, not markdown conversion.
        if (BARE_URL_RE.test(text.trim())) return false;
        // Title node: keep title paste plain text — never inject blocks into the title.
        if (inTitle(view.state.selection.$from)) return false;

        const slice = markdownTextToSlice(schema, text);
        if (!slice) return false;
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
        return true;
      },
    },
  });
}
