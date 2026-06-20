import { describe, it, expect } from 'vitest';
import type { BlockBody } from '@deltos/shared';
import { computeCharDelta, deltaMagnitude, noteText } from '../src/lib/textDelta.js';

const para = (id: string, text: string): BlockBody[number] => ({
  id,
  type: 'paragraph',
  content: { segments: [{ text }] },
});

describe('computeCharDelta — split (not net) char delta', () => {
  it('identical text → zero/zero', () => {
    expect(computeCharDelta('hello world', 'hello world')).toEqual({ charsAdded: 0, charsRemoved: 0 });
  });

  it('pure append counts only added', () => {
    expect(computeCharDelta('hello', 'hello world')).toEqual({ charsAdded: 6, charsRemoved: 0 });
  });

  it('pure deletion counts only removed', () => {
    expect(computeCharDelta('hello world', 'hello')).toEqual({ charsAdded: 0, charsRemoved: 6 });
  });

  it('a contiguous middle replace is exact and split, not netted', () => {
    // "the cat sat" → "the dog sat": prefix "the ", suffix " sat", middle cat→dog.
    expect(computeCharDelta('the cat sat', 'the dog sat')).toEqual({ charsAdded: 3, charsRemoved: 3 });
  });

  it('prepend counts only added (no false suffix/prefix overlap)', () => {
    expect(computeCharDelta('world', 'hello world')).toEqual({ charsAdded: 6, charsRemoved: 0 });
  });

  it('from empty → whole string added; to empty → whole string removed', () => {
    expect(computeCharDelta('', 'abcd')).toEqual({ charsAdded: 4, charsRemoved: 0 });
    expect(computeCharDelta('abcd', '')).toEqual({ charsAdded: 0, charsRemoved: 4 });
  });

  it('deltaMagnitude = added + removed', () => {
    expect(deltaMagnitude({ charsAdded: 12, charsRemoved: 3 })).toBe(15);
  });
});

describe('noteText — title + body projection (reuses block-text extraction)', () => {
  it('joins title and body text with a newline', () => {
    const body: BlockBody = [para('b1', 'first line'), para('b2', 'second line')];
    expect(noteText('My Title', body)).toBe('My Title\nfirst line second line');
  });

  it('an empty body still yields the title (so title-only edits register a delta)', () => {
    expect(noteText('Just a title', [])).toBe('Just a title\n');
  });

  it('a title edit is visible to the delta', () => {
    const body: BlockBody = [para('b1', 'unchanged body')];
    const before = noteText('Draft', body);
    const after = noteText('Final', body);
    expect(computeCharDelta(before, after)).toEqual({ charsAdded: 5, charsRemoved: 5 });
  });
});
