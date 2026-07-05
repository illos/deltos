/**
 * Local fuzzy-search engine for notes.
 *
 * Scoring:
 *   – Title match is weighted 3× over body match.
 *   – Exact substring > word-prefix > fuzzy (bigram Dice coefficient).
 *   – Multi-word query: ALL terms must match somewhere; score is the sum per term.
 *   – Results are sorted by score descending and capped at MAX_RESULTS.
 *
 * Pure functions only — no I/O, no React.
 */

import type { Note } from '@deltos/shared';
import { getExtract } from '@deltos/shared';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MatchRange {
  start: number;
  end: number;
}

export interface NoteSearchResult {
  note: Note;
  score: number;
  /** Short excerpt around the best match (~100 chars, with ellipsis) — from body OR a file's extract page. */
  snippet: string;
  /** Ranges within `snippet` to highlight. */
  snippetRanges: MatchRange[];
  /** Ranges within `note.title` to highlight. */
  titleRanges: MatchRange[];
  /**
   * ROAD-0014: the 1-based PDF PAGE the winning snippet came from, or null when the match is in the note body
   * or an image OCR extract (no page). Drives the "p. N" result badge + the page-jump deep-link.
   */
  page: number | null;
}

// ---------------------------------------------------------------------------
// Searchable text sources (ROAD-0014)
// ---------------------------------------------------------------------------

/** One searchable text region of a note: the body (page null) or a file's extract page (PDF page / null). */
interface TextSource {
  page: number | null;
  raw: string;
  low: string;
}

/**
 * The body-plus-extract text sources for a note. Normal notes → just the body (one source, page null).
 * File notes carrying a `sys:extract` (ROAD-0014) additionally contribute one source PER extract page, so a
 * match inside a PDF/image maps back to its page for the snippet + badge + jump. Cheap for non-file notes:
 * `getExtract` is an O(1) key miss (no parse) when there is no extract.
 */
function noteSources(note: Note): TextSource[] {
  const sources: TextSource[] = [];
  const bodyRaw = noteBodyText(note);
  sources.push({ page: null, raw: bodyRaw, low: bodyRaw.toLowerCase() });

  const extract = getExtract(note.properties);
  if (extract) {
    for (const pg of extract.pages) {
      if (!pg.t) continue;
      sources.push({ page: pg.p, raw: pg.t, low: pg.t.toLowerCase() });
    }
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Body text extraction (mirrors notePreview.blockText — shared shape)
// ---------------------------------------------------------------------------

function blockToText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const o = content as Record<string, unknown>;
  if (Array.isArray(o['segments'])) {
    return (o['segments'] as Array<Record<string, unknown>>)
      .map((s) => (typeof s['text'] === 'string' ? s['text'] : ''))
      .join('');
  }
  if (typeof o['code'] === 'string') return o['code'];
  return '';
}

/** All text from a note's body blocks joined by spaces. Accepts any `{ body }` (version snapshots
 *  carry the same body shape as a Note), so the history-capture delta layer can reuse it. */
export function noteBodyText(note: Pick<Note, 'body'>): string {
  const body = (note.body as Array<{ content?: unknown }> | undefined) ?? [];
  return body
    .map((b) => blockToText(b.content))
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Fuzzy matching — Sørensen–Dice coefficient on character bigrams
// ---------------------------------------------------------------------------

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const k = s[i]! + s[i + 1]!;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function diceCoeff(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ba = bigrams(a);
  const bb = bigrams(b);
  let inter = 0;
  for (const [k, va] of ba) {
    inter += Math.min(va, bb.get(k) ?? 0);
  }
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

// Dice score below this threshold → no fuzzy match.
const FUZZY_MIN = 0.4;

/** Best Dice coefficient of `term` against any whitespace-delimited word in `text`. */
function bestWordDice(term: string, text: string): number {
  let best = 0;
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const d = diceCoeff(term, m[0]);
    if (d > best) best = d;
    if (best === 1) break;
  }
  return best >= FUZZY_MIN ? best : 0;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Score a single query term against a (already lower-cased) text field.
 * Returns 0 when the term is absent, >0 otherwise.
 *
 * Priority: word-prefix match (120) > exact substring (100) > fuzzy word (0–80).
 */
function scoreTerm(term: string, textLow: string): number {
  if (!textLow || !term) return 0;

  // Word-prefix match (e.g. "not" matches "notes")
  if (new RegExp(`(?:^|\\s)${escapeRe(term)}`).test(textLow)) return 120;

  // Exact substring anywhere
  if (textLow.includes(term)) return 100;

  // Short terms are too noisy for fuzzy
  if (term.length < 3) return 0;

  const d = bestWordDice(term, textLow);
  return d > 0 ? Math.round(d * 80) : 0;
}

// ---------------------------------------------------------------------------
// Highlight range computation
// ---------------------------------------------------------------------------

/**
 * Compute non-overlapping ranges where any of `terms` appears in `text`
 * (case-insensitive exact substring). Returns sorted, merged ranges.
 */
export function highlightRanges(text: string, terms: readonly string[]): MatchRange[] {
  if (!text || !terms.length) return [];
  const low = text.toLowerCase();
  const raw: MatchRange[] = [];

  for (const term of terms) {
    if (!term) continue;
    let i = 0;
    while (i < low.length) {
      const idx = low.indexOf(term, i);
      if (idx < 0) break;
      raw.push({ start: idx, end: idx + term.length });
      i = idx + term.length;
    }
  }

  if (!raw.length) return [];
  raw.sort((a, b) => a.start - b.start);

  const merged: MatchRange[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Snippet extraction
// ---------------------------------------------------------------------------

const SNIPPET_LEN = 100;

function extractSnippet(
  bodyText: string,
  terms: readonly string[],
): { text: string; ranges: MatchRange[] } {
  if (!bodyText) return { text: '', ranges: [] };

  const low = bodyText.toLowerCase();

  // Anchor: earliest exact occurrence of any term (or start of text).
  let anchor = bodyText.length;
  for (const term of terms) {
    const i = low.indexOf(term);
    if (i >= 0 && i < anchor) anchor = i;
  }
  if (anchor === bodyText.length) anchor = 0;

  const half = Math.floor(SNIPPET_LEN / 2);
  const rawStart = Math.max(0, anchor - half);
  const rawEnd = Math.min(bodyText.length, rawStart + SNIPPET_LEN);
  const hasPrefix = rawStart > 0;
  const hasSuffix = rawEnd < bodyText.length;
  const slice = bodyText.slice(rawStart, rawEnd);

  const text = (hasPrefix ? '…' : '') + slice + (hasSuffix ? '…' : '');
  const offset = hasPrefix ? 1 : 0; // '…' is one char (U+2026)
  const localRanges = highlightRanges(slice, terms);
  const ranges = localRanges.map((r) => ({ start: r.start + offset, end: r.end + offset }));

  return { text, ranges };
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

const MAX_RESULTS = 50;

/**
 * Fuzzy-search `notes` by `query`. Returns relevance-ranked results, capped at 50.
 *
 * Scoring: title matched ×3 over body; all query terms must match somewhere.
 * Fuzzy: Sørensen–Dice on character bigrams (handles 1–2 char typos).
 */
export function searchNotes(notes: readonly Note[], query: string): NoteSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const terms = q.split(/\s+/).filter(Boolean);
  const results: NoteSearchResult[] = [];

  for (const note of notes) {
    const titleLow = (note.title ?? '').toLowerCase();
    // Body + (for file notes) each extract page — so a match inside a PDF/image scores + maps to its page.
    const sources = noteSources(note);

    let total = 0;
    let allMatch = true;
    // Per-source aggregate term score → the source the snippet + page come from (the best-matching region).
    const sourceAgg = new Array<number>(sources.length).fill(0);

    for (const term of terms) {
      const ts = scoreTerm(term, titleLow);
      let bestBody = 0;
      for (let si = 0; si < sources.length; si++) {
        const s = scoreTerm(term, sources[si]!.low);
        if (s > 0) sourceAgg[si]! += s;
        if (s > bestBody) bestBody = s;
      }
      const combined = ts * 3 + bestBody;
      if (combined === 0) { allMatch = false; break; }
      total += combined;
    }

    if (!allMatch || total === 0) continue;

    // Pick the winning source: the one with the highest aggregate term score. A title-only match (no source
    // scored) falls back to the body source (index 0), so the snippet/page behave exactly as before.
    let bestIdx = 0;
    let bestAgg = -1;
    for (let si = 0; si < sources.length; si++) {
      if (sourceAgg[si]! > bestAgg) { bestAgg = sourceAgg[si]!; bestIdx = si; }
    }
    const chosen = sources[bestIdx]!;

    const titleRanges = highlightRanges(note.title ?? '', terms);
    const { text: snippet, ranges: snippetRanges } = extractSnippet(chosen.raw, terms);

    results.push({ note, score: total, snippet, snippetRanges, titleRanges, page: chosen.page });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, MAX_RESULTS);
}
