/**
 * SymSpell — a hand-port of Wolf Garbe's Symmetric Delete spelling-correction algorithm (MIT). Zero-dep,
 * editor-AGNOSTIC (operates on plain strings; no PM/editor types) so it stays inside the Deck extraction
 * boundary. Runs in a Web Worker (see spellWorker.ts) — the index build + lookups are off the main thread.
 *
 * Idea: precompute, for every dictionary word, the set of strings reachable by deleting up to `maxEdit`
 * characters (bounded to the first `prefixLength` chars — SymSpell's key optimization that keeps the index
 * size roughly constant per word). At lookup, generate the same delete-set for the input and intersect via
 * the index → candidate words a few edits away, then rank by (edit distance asc, frequency desc).
 *
 * The dictionary is supplied in FREQUENCY ORDER (most frequent first); frequency = (N − index), so earlier
 * words rank higher. That lets the shipped asset be words-only (no stored counts) — half the bytes.
 */

export interface SymSpellOptions {
  /** Max edit distance for suggestions (default 2). */
  maxEditDistance?: number;
  /** Only generate deletes over the first N chars of a word (default 7) — bounds index size. */
  prefixLength?: number;
}

export interface SpellSuggestion {
  word: string;
  distance: number;
  /** Higher = more frequent (rank-derived). */
  freq: number;
}

export class SymSpell {
  private readonly maxEdit: number;
  private readonly prefixLength: number;
  private readonly words = new Map<string, number>(); // word → frequency (rank-derived)
  private readonly deletes = new Map<string, string[]>(); // delete-variant → source dict words

  constructor(opts: SymSpellOptions = {}) {
    this.maxEdit = opts.maxEditDistance ?? 2;
    this.prefixLength = opts.prefixLength ?? 7;
  }

  /** Build the index from a frequency-ORDERED word list (most frequent first). */
  build(wordsInFreqOrder: readonly string[]): void {
    const n = wordsInFreqOrder.length;
    for (let i = 0; i < n; i++) {
      const word = wordsInFreqOrder[i]!;
      if (this.words.has(word)) continue;
      this.words.set(word, n - i);
      for (const del of this.deleteVariants(word)) {
        const bucket = this.deletes.get(del);
        if (bucket) bucket.push(word);
        else this.deletes.set(del, [word]);
      }
    }
  }

  /** Is the word in the dictionary (case-insensitive)? */
  has(word: string): boolean {
    return this.words.has(word.toLowerCase());
  }

  /** Ranked suggestions for a (presumed-misspelled) term, nearest + most-frequent first. */
  lookup(input: string, maxEdit = this.maxEdit): SpellSuggestion[] {
    const term = input.toLowerCase();
    const exactFreq = this.words.get(term);
    if (exactFreq !== undefined) return [{ word: term, distance: 0, freq: exactFreq }];

    const candidates = new Set<string>();
    for (const del of this.deleteVariants(term)) {
      const bucket = this.deletes.get(del);
      if (bucket) for (const w of bucket) candidates.add(w);
    }
    const out: SpellSuggestion[] = [];
    for (const cand of candidates) {
      const distance = damerauOSA(term, cand, maxEdit);
      if (distance >= 0) {
        const freq = this.words.get(cand);
        if (freq !== undefined) out.push({ word: cand, distance, freq });
      }
    }
    out.sort((a, b) => a.distance - b.distance || b.freq - a.freq);
    return out;
  }

  /** The prefix of `word` plus every string reachable by ≤ maxEdit deletions within that prefix. */
  private deleteVariants(word: string): Set<string> {
    const prefix = word.length > this.prefixLength ? word.slice(0, this.prefixLength) : word;
    const out = new Set<string>([prefix]);
    this.deleteRecurse(prefix, this.maxEdit, out);
    return out;
  }
  private deleteRecurse(word: string, depth: number, out: Set<string>): void {
    if (depth <= 0 || word.length <= 1) return;
    for (let i = 0; i < word.length; i++) {
      const del = word.slice(0, i) + word.slice(i + 1);
      if (!out.has(del)) {
        out.add(del);
        if (depth - 1 > 0) this.deleteRecurse(del, depth - 1, out);
      }
    }
  }
}

/**
 * Damerau optimal-string-alignment distance with early exit at `max` (returns -1 when the distance exceeds
 * max). OSA counts a transposition of adjacent chars as one edit (so "recieve"→"receive" = 1), which is the
 * common typo class — exactly what a speller wants to rank highest.
 */
export function damerauOSA(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return -1;
  if (la === 0) return lb <= max ? lb : -1;
  if (lb === 0) return la <= max ? la : -1;

  let prevPrev = new Array<number>(lb + 1).fill(0);
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      // All indices are in-bounds by the loop construction; assertions satisfy noUncheckedIndexedAccess.
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prevPrev[j - 2]! + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return -1; // whole row already exceeds the budget
    const tmp = prevPrev;
    prevPrev = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[lb]! <= max ? prev[lb]! : -1;
}

/** A misspelled span within a checked string: [start, end) char offsets + the offending word. */
export interface MisspelledRange {
  start: number;
  end: number;
  word: string;
}

// A "word" for checking: runs of letters/apostrophes. Numbers, URLs-ish tokens, and 1-char tokens are
// skipped (too noisy to flag). Apostrophes inside a word are kept (contractions) but trimmed at the edges.
const WORD_RE = /[A-Za-z][A-Za-z']*/g;

/**
 * Find misspelled words in `text` using `spell` — editor-agnostic (plain string → char ranges). The caller
 * (the editor adapter) maps these ranges onto document positions. Words in the dictionary, ≤1 char, or
 * fully uppercase (likely acronyms) are not flagged.
 */
export function checkText(spell: SymSpell, text: string): MisspelledRange[] {
  const ranges: MisspelledRange[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const raw = m[0];
    const word = raw.replace(/^'+|'+$/g, ''); // trim edge apostrophes
    if (word.length <= 1) continue;
    if (word === word.toUpperCase()) continue; // ACRONYMS — skip
    if (spell.has(word)) continue;
    const start = m.index + raw.indexOf(word);
    ranges.push({ start, end: start + word.length, word });
  }
  return ranges;
}
