/**
 * PDF reader Slice 3 — the PURE match-index logic (pdf-reader.md §5.2). Unit-tests the engine-free search core:
 * page-text concatenation + offset map, case-insensitive matching, the flat document-ordered match list (incl.
 * search-while-indexing with null pages), and the escape-safe item segmentation that the text layer renders.
 */
import { describe, it, expect } from 'vitest';
import {
  normalize,
  pagePlainText,
  findPageMatches,
  buildMatches,
  splitItemForRender,
} from '../src/views/pdf/pdfSearch.js';
import type { PdfTextItem, PdfPageText } from '../src/views/pdf/pdfEngine.js';

function item(str: string): PdfTextItem {
  return { str, left: 0, top: 0, width: str.length * 5, height: 10 };
}
function page(...strs: string[]): PdfPageText {
  return { items: strs.map(item) };
}

describe('pdfSearch — plain text + offset map', () => {
  it('concatenates items and records each item start offset', () => {
    const { text, itemStarts } = pagePlainText(page('Hello ', 'world').items);
    expect(text).toBe('Hello world');
    expect(itemStarts).toEqual([0, 6]);
  });
});

describe('pdfSearch — findPageMatches', () => {
  it('finds all non-overlapping case-insensitive occurrences with correct char ranges', () => {
    const m = findPageMatches(page('the cat sat on THE mat').items, normalize('the'));
    expect(m).toEqual([
      { charStart: 0, charEnd: 3 },
      { charStart: 15, charEnd: 18 },
    ]);
  });

  it('an empty query yields no matches', () => {
    expect(findPageMatches(page('anything').items, '')).toEqual([]);
  });
});

describe('pdfSearch — buildMatches across pages', () => {
  const pages: Array<PdfPageText | null> = [
    page('alpha beta alpha'), // 2 on page 0
    page('gamma'), // 0
    page('beta ALPHA'), // 1 on page 2
  ];

  it('produces a flat, document-ordered match list with an accurate total (N matches)', () => {
    const m = buildMatches(pages, 'alpha');
    expect(m.length).toBe(3); // "3 of N" total
    expect(m.map((x) => x.pageIndex)).toEqual([0, 0, 2]);
  });

  it('search-while-indexing: a null (not-yet-extracted) page simply contributes nothing, total grows later', () => {
    const partial: Array<PdfPageText | null> = [pages[0]!, null, null];
    expect(buildMatches(partial, 'alpha').length).toBe(2);
    // when page 2 arrives, the same query yields the full total.
    expect(buildMatches(pages, 'alpha').length).toBe(3);
  });

  it('a whitespace/empty query yields no matches', () => {
    expect(buildMatches(pages, '   ')).toEqual([]);
  });
});

describe('pdfSearch — splitItemForRender (escape-safe segmentation)', () => {
  it('splits one run into plain / match / active segments by char range', () => {
    const it = item('the cat sat'); // itemStart 0
    const segs = splitItemForRender(
      it,
      0,
      [{ charStart: 4, charEnd: 7 }], // "cat"
      { charStart: 4, charEnd: 7 }, // active
    );
    expect(segs).toEqual([
      { text: 'the ', kind: 'plain' },
      { text: 'cat', kind: 'active' },
      { text: ' sat', kind: 'plain' },
    ]);
  });

  it('marks non-active matches as match and only the active range as active', () => {
    const it = item('aXaXa'); // matches on each "a" at 0,2,4
    const segs = splitItemForRender(
      it,
      0,
      [
        { charStart: 0, charEnd: 1 },
        { charStart: 2, charEnd: 3 },
        { charStart: 4, charEnd: 5 },
      ],
      { charStart: 2, charEnd: 3 },
    );
    expect(segs).toEqual([
      { text: 'a', kind: 'match' },
      { text: 'X', kind: 'plain' },
      { text: 'a', kind: 'active' },
      { text: 'X', kind: 'plain' },
      { text: 'a', kind: 'match' },
    ]);
  });

  it('NEVER emits markup: a run of attacker text comes back as verbatim string slices, not HTML', () => {
    const evil = '<img src=x onerror=alert(1)></span>';
    const it = item(evil);
    // a match on "img" — the dangerous characters must survive untouched in the surrounding plain slices.
    const segs = splitItemForRender(it, 0, [{ charStart: 1, charEnd: 4 }]);
    expect(segs.map((s) => s.text).join('')).toBe(evil); // lossless: no escaping/stripping in the logic
    expect(segs.find((s) => s.kind === 'match')?.text).toBe('img');
    // The plain segment still carries the literal angle brackets as data.
    expect(segs[0]).toEqual({ text: '<', kind: 'plain' });
  });
});
