import type { Command, EditorState, Transaction } from 'prosemirror-state';
import type { DeltoSchema } from './schema.js';
import type { InsertHandler, TransformRegistry } from './inputPipeline/index.js';
import { normalizeLinkInput } from './openLink.js';

/**
 * Typed-URL autolink detection (rung-1, broadened — Jim wants bare 'google.com' to linkify, not just
 * scheme'd URLs). SPACE + ENTER boundaries and the Backspace unwrap all register into the unified input
 * pipeline ({@link registerAutolinkTransforms}, [ROAD-0007] step 3) — both keyboards consume them
 * generically. Paste→card stays scheme-required (separate).
 *
 * 🚨 FALSE-POSITIVE GUARD: a naive domain.tld regex over-fires on 'etc.', 'file.txt', '3.14', 'U.S.', 'a.m.'.
 * So a bare domain only linkifies when its TLD is in this CURATED allowlist AND the token ENDS in .<tld>
 * (no trailing dot). Curated to common generic TLDs (incl. the common-as-generic 2-letter io/co/ai/me) but
 * NOT abbreviation-colliding country codes (us/am). Jim tunes on feel.
 */
export const URL_TLDS = [
  'com', 'org', 'net', 'io', 'dev', 'co', 'app', 'ai', 'edu', 'gov', 'me', 'info', 'xyz', 'blog', 'tech', 'design',
] as const;

// Core patterns (no end-anchor — the SPACE rule appends \s$, the ENTER detector appends $). The bare-domain
// lookbehind (?<![@\w.-]) requires a clean left boundary so an email's domain ('a@google.com') or a
// mid-token suffix ('oogle.com' inside a word) never linkifies.
const SCHEME_CORE = `(https?://[^\\s]+)`;
const BARE_CORE = `(?<![@\\w.-])((?:[a-z0-9-]+\\.)+(?:${URL_TLDS.join('|')})(?:/[^\\s]*)?)`;

const SCHEME_AT_END = new RegExp(`${SCHEME_CORE}$`, 'i');
const BARE_AT_END = new RegExp(`${BARE_CORE}$`, 'i');

/** The trailing URL at the end of `textBeforeCaret` — a scheme'd URL or an allowlisted bare domain — else null. */
export function detectTrailingUrl(textBeforeCaret: string): string | null {
  return SCHEME_AT_END.exec(textBeforeCaret)?.[1] ?? BARE_AT_END.exec(textBeforeCaret)?.[1] ?? null;
}

/**
 * ENTER/boundary linkify: if the text before the caret ends in a URL/bare-domain, apply the link mark to it
 * (href via normalizeLinkInput → https:// prepended for bare domains). Returns true if it linked. NO char
 * inserted — the caller then performs the normal Enter. Shared by the keymap (hardware) + deckAdapter (keypad).
 */
export function linkifyTrailingUrl(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const link = state.schema.marks['link'];
  if (!link || !state.selection.empty) return false;
  const pos = state.selection.from;
  const $b = state.doc.resolve(pos);
  if ($b.parent.type.name === 'title') return false; // never autolink the note title
  const blockStart = $b.start();
  const textBefore = state.doc.textBetween(blockStart, pos);
  const url = detectTrailingUrl(textBefore);
  if (!url) return false;
  const href = normalizeLinkInput(url);
  if (!href) return false;
  const from = blockStart + (textBefore.length - url.length);
  if (state.doc.rangeHasMark(from, pos, link)) return false; // already linked
  if (dispatch) dispatch(state.tr.addMark(from, pos, link.create({ href, title: null })).removeStoredMark(link));
  return true;
}

/**
 * Backspace at the RIGHT EDGE of a linked run → strip the 'link' mark across the whole contiguous run
 * (keep the text, delete NO char), CONSUMING the backspace; a second backspace then deletes normally. The
 * link thus edits/undoes like an inline formula: unwrap to plain URL text, which SPACE/ENTER then re-links
 * (#74). Returns false (normal delete) when the caret isn't at a linked run's right edge. Shared by the
 * keymap (hardware) + deckAdapter.backspace (the Deck bypasses the keymap — [[deck-keypad-bypasses-…]]).
 *
 * A form-created link whose visible text is a custom Title (not a URL) also unwraps to that title text;
 * it simply won't auto-relink (not a URL) — expected, not special-cased.
 */
export const unwrapLinkBackspace: Command = (state, dispatch): boolean => {
  const link = state.schema.marks['link'];
  if (!link || !state.selection.empty) return false;
  const $pos = state.doc.resolve(state.selection.from);
  const before = $pos.nodeBefore;
  if (!before || !before.isText || !link.isInSet(before.marks)) return false; // not at a linked run's right edge
  const after = $pos.nodeAfter;
  if (after && after.isText && link.isInSet(after.marks)) return false; // caret is INSIDE the run, not at its edge
  // Walk back over the contiguous linked text nodes to the run start.
  let from = $pos.pos;
  for (;;) {
    const nb = state.doc.resolve(from).nodeBefore;
    if (nb && nb.isText && link.isInSet(nb.marks)) from -= nb.nodeSize;
    else break;
  }
  if (dispatch) dispatch(state.tr.removeMark(from, $pos.pos, link));
  return true;
};

/**
 * Register the autolink transforms into the unified input pipeline ([ROAD-0007] step 3) — the SPACE
 * boundary as insert rules (fires on native typing AND the Deck's single space, closing the old
 * Deck-single-space gap), plus the edit surface: link-unwrap on Backspace and linkify on the shared
 * Enter boundary. Registered AFTER markdown (§5.4 order); enterBoundary lands after formula-boundary-wrap
 * ("a trailing token is either a formula or a URL, not both").
 *
 * SPACE rules are NON-consuming: the handler marks the URL and re-inserts the boundary space itself
 * (rule-fired = the default insert is suppressed). The pre-pipeline native rule silently SWALLOWED the
 * space (it never re-inserted it) while the Deck path preserved it — preserve is the correct unified
 * behavior (hexcolor's boundary space set the precedent).
 */
export function registerAutolinkTransforms(transforms: TransformRegistry, schema: DeltoSchema): void {
  const link = schema.marks['link'];
  if (link) {
    const linkifyOnSpace = (normalize: boolean): InsertHandler => (state, match, start) => {
      const url = match[1];
      if (!url) return null;
      const href = normalize ? normalizeLinkInput(url) : url;
      if (!href) return null;
      if (state.doc.rangeHasMark(start, start + url.length, link)) return null; // already linked
      return state.tr
        .addMark(start, start + url.length, link.create({ href, title: null }))
        .insertText(' ')
        .removeStoredMark(link);
    };
    // Scheme'd URL keeps its href verbatim; a bare domain goes through normalizeLinkInput (https:// prefix).
    transforms.addInsert({ id: 'autolink-scheme', match: /(https?:\/\/[^\s]+)\s$/, handler: linkifyOnSpace(false) });
    transforms.addInsert({ id: 'autolink-bare', match: new RegExp(`${BARE_CORE}\\s$`, 'i'), handler: linkifyOnSpace(true) });
  }
  transforms.addEdit('backspace', { id: 'link-unwrap', cmd: unwrapLinkBackspace });
  transforms.addEdit('enterBoundary', { id: 'linkify', cmd: linkifyTrailingUrl });
}
