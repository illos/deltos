/**
 * pdfSearch (pdf-reader.md §5.2 / Slice 3) — the PURE match-index logic for in-PDF text search, kept out of the
 * React component so it is trivially unit-testable and so the escape-safety boundary is one small, auditable
 * surface.
 *
 * SECURITY (gate PDF-S): every function here treats PDF text + the query as OPAQUE DATA. It only ever does
 * string slicing / lowercasing / index math — it NEVER builds HTML, never concatenates markup, never interprets
 * a `<...>` in the text or the query as anything but characters. `splitItemForRender` returns a list of
 * `{ text, kind }` SEGMENTS (plain data); the React text layer maps each segment to a text node / `<mark>` whose
 * child is the raw string. So attacker-controlled text reaches the DOM only as a React text node — inert.
 */

import type { PdfPageText, PdfTextItem } from './pdfEngine.js';

/** A match located in the document: a char range within a page's concatenated plain text. */
export interface PdfMatch {
  /** 0-based page index. */
  pageIndex: number;
  /** Inclusive start / exclusive end char offsets into the page's concatenated text (see `pagePlainText`). */
  charStart: number;
  charEnd: number;
}

/** A render segment of one text item: a slice of the run + whether it is (active) match or plain text. */
export interface TextSegment {
  text: string;
  kind: 'plain' | 'match' | 'active';
}

/**
 * Lowercase for case-insensitive matching. We deliberately do NOT collapse/strip characters, so the result has
 * the SAME length as the input and char offsets map 1:1 back to the original — which keeps the offset→item math
 * exact. (ASCII lowercasing is length-preserving; the app's user is English, so the rare length-changing Unicode
 * fold is a non-issue.)
 */
export function normalize(s: string): string {
  return s.toLowerCase();
}

/**
 * Concatenate a page's text items into one searchable string + record where each item begins. Items are joined
 * with no separator; `itemStarts[k]` is the char offset at which `items[k].str` begins, so a match range can be
 * mapped back to the items it overlaps. (A separator-free join can in theory create a match straddling two runs;
 * the overlap math in `splitItemForRender` handles that — each run highlights only its own slice.)
 */
export function pagePlainText(items: readonly PdfTextItem[]): { text: string; itemStarts: number[] } {
  let text = '';
  const itemStarts: number[] = [];
  for (const it of items) {
    itemStarts.push(text.length);
    text += it.str;
  }
  return { text, itemStarts };
}

/**
 * Find every (non-overlapping, left-to-right) occurrence of `normalizedQuery` in one page's text. Returns char
 * ranges into that page's concatenated text. An empty/whitespace query yields no matches.
 */
export function findPageMatches(items: readonly PdfTextItem[], normalizedQuery: string): Array<{ charStart: number; charEnd: number }> {
  const q = normalizedQuery;
  if (q.length === 0) return [];
  const { text } = pagePlainText(items);
  const hay = normalize(text);
  const out: Array<{ charStart: number; charEnd: number }> = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(q, from);
    if (at === -1) break;
    out.push({ charStart: at, charEnd: at + q.length });
    from = at + q.length; // non-overlapping
  }
  return out;
}

/**
 * Build the flat, document-ordered match list across all (so-far-indexed) pages. `pages[i]` may be null (that
 * page's text isn't extracted yet) — it simply contributes no matches until it arrives, so search-while-indexing
 * returns what's known so far and grows as pages complete (§5.2).
 */
export function buildMatches(pages: ReadonlyArray<PdfPageText | null>, rawQuery: string): PdfMatch[] {
  const q = normalize(rawQuery.trim());
  if (q.length === 0) return [];
  const matches: PdfMatch[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!page) continue;
    for (const r of findPageMatches(page.items, q)) {
      matches.push({ pageIndex: i, charStart: r.charStart, charEnd: r.charEnd });
    }
  }
  return matches;
}

/**
 * Split ONE text item's string into ordered render segments, marking the parts covered by matches on this page.
 * `itemStart` is this item's char offset within the page text (from `pagePlainText`). `ranges` are the page's
 * match ranges; `activeRange` (if any) is the currently-selected match — its overlap is marked `active` so the
 * text layer can style it distinctly.
 *
 * Pure string slicing only — the returned `text` slices are verbatim substrings of the untrusted run; the caller
 * renders each as a React text node, so nothing here can inject markup.
 */
export function splitItemForRender(
  item: PdfTextItem,
  itemStart: number,
  ranges: ReadonlyArray<{ charStart: number; charEnd: number }>,
  activeRange?: { charStart: number; charEnd: number } | null,
): TextSegment[] {
  const str = item.str;
  const itemEnd = itemStart + str.length;
  // Per-char highlight flags within this item: 0 = plain, 1 = match, 2 = active. Active wins.
  const flags = new Uint8Array(str.length);
  const mark = (r: { charStart: number; charEnd: number }, value: 1 | 2) => {
    const a = Math.max(r.charStart, itemStart);
    const b = Math.min(r.charEnd, itemEnd);
    for (let i = a; i < b; i++) flags[i - itemStart] = value;
  };
  for (const r of ranges) mark(r, 1);
  if (activeRange) mark(activeRange, 2);

  const segments: TextSegment[] = [];
  let runStart = 0;
  const kindOf = (f: number): TextSegment['kind'] => (f === 2 ? 'active' : f === 1 ? 'match' : 'plain');
  for (let i = 1; i <= str.length; i++) {
    if (i === str.length || flags[i] !== flags[i - 1]) {
      segments.push({ text: str.slice(runStart, i), kind: kindOf(flags[runStart] ?? 0) });
      runStart = i;
    }
  }
  return segments;
}
