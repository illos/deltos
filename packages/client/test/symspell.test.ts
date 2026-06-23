/**
 * #69 §5 spellcheck — the Deck-core SymSpell engine (hand-port). Pure, no worker: builds an index from a
 * small frequency-ordered word list and asserts membership, ranked lookup, the Damerau transposition case,
 * and the editor-agnostic checkText tokenizer/ranges.
 */
import { describe, it, expect } from 'vitest';
import { SymSpell, damerauOSA, checkText } from '../src/deck/spellcheck/symspell.js';

const build = (words: string[]) => { const s = new SymSpell(); s.build(words); return s; };

describe('SymSpell — membership + lookup', () => {
  it('has() is case-insensitive membership', () => {
    const s = build(['receive', 'believe', 'the']);
    expect(s.has('receive')).toBe(true);
    expect(s.has('Receive')).toBe(true);
    expect(s.has('recieve')).toBe(false);
  });

  it('a correctly-spelled word looks up as distance 0 (no correction needed)', () => {
    const s = build(['receive']);
    const out = s.lookup('receive');
    expect(out[0]).toMatchObject({ word: 'receive', distance: 0 });
  });

  it('corrects a transposition at distance 1 (recieve → receive, Damerau OSA)', () => {
    const s = build(['receive', 'believe', 'relieve']);
    const out = s.lookup('recieve');
    expect(out[0]?.word).toBe('receive');
    expect(out[0]?.distance).toBe(1);
  });

  it('ranks equidistant candidates by frequency (dictionary order = frequency desc)', () => {
    // all one edit from "caz"; freq order is the build order, so "cat" (most frequent) ranks first.
    const s = build(['cat', 'car', 'can', 'cap']);
    const out = s.lookup('caz');
    expect(out.map((c) => c.word)).toEqual(['cat', 'car', 'can', 'cap']);
    expect(out.every((c) => c.distance === 1)).toBe(true);
  });

  it('returns nothing for a term beyond max edit distance from any word', () => {
    const s = build(['receive']);
    expect(s.lookup('xyzzy')).toEqual([]);
  });
});

describe('damerauOSA', () => {
  it('adjacent transposition is one edit', () => {
    expect(damerauOSA('recieve', 'receive', 2)).toBe(1);
  });
  it('one substitution is one edit', () => {
    expect(damerauOSA('cat', 'car', 2)).toBe(1);
  });
  it('returns -1 beyond the max budget (early exit)', () => {
    expect(damerauOSA('abcdef', 'uvwxyz', 2)).toBe(-1);
  });
});

describe('checkText — editor-agnostic misspelled ranges', () => {
  it('flags misspelled words, skips dictionary words / acronyms / single chars, with correct offsets', () => {
    const s = build(['believe', 'the', 'cat', 'a']);
    const text = 'I beleive teh cat';
    const ranges = checkText(s, text);
    // 'I' = single-char + uppercase (skipped); 'cat' in dict; 'beleive' + 'teh' misspelled.
    expect(ranges.map((r) => r.word)).toEqual(['beleive', 'teh']);
    // offsets point at the exact substring.
    for (const r of ranges) expect(text.slice(r.start, r.end)).toBe(r.word);
  });

  it('does not flag a fully-correct sentence', () => {
    const s = build(['the', 'cat', 'sat']);
    expect(checkText(s, 'the cat sat')).toEqual([]);
  });
});
