/**
 * Deploy 3 — Lane 3 slice A: the three new marks (underline / strikethrough / highlight) across the
 * serializer round-trip, the isTextSegment guard (forward-compat), and the clipboard text/plain export.
 *
 * Round-trip invariant (spec §1): spineToPmDoc(pmDocToSpine(doc)) is semantically identical for a doc
 * with all six inline marks + a link, including overlapping marks on one run.
 */
import { describe, it, expect } from 'vitest';
import { Slice, Fragment } from 'prosemirror-model';
import type { BlockBody, BlockId } from '@deltos/shared';
import { deltoSchema } from '../src/editor/schema.js';
import { pmDocToSpine, spineToPmDoc, isTextSegment } from '../src/editor/serializer.js';
import { sliceToPlainText } from '../src/editor/clipboard.js';

const PID = '11111111-1111-4111-8111-111111111111' as BlockId;

// One paragraph carrying every inline mark + an OVERLAPPING run (bold+italic) + a link.
const roundTripBody: BlockBody = [{
  id: PID,
  type: 'paragraph',
  content: {
    segments: [
      { text: 'x' },
      { text: 'bi', bold: true, italic: true }, // overlapping marks on one run
      { text: 'u', underline: true },
      { text: 's', strike: true },
      { text: 'h', highlight: true },
      { text: 'c', code: true },
      { text: 'site', link: 'https://example.com' },
    ],
  },
}];

// Clean single-mark runs separated by spaces — for the exact clipboard-string assertion.
const clipboardBody: BlockBody = [{
  id: PID,
  type: 'paragraph',
  content: {
    segments: [
      { text: 'plain ' },
      { text: 'b', bold: true }, { text: ' ' },
      { text: 'i', italic: true }, { text: ' ' },
      { text: 's', strike: true }, { text: ' ' },
      { text: 'h', highlight: true }, { text: ' ' },
      { text: 'u', underline: true }, { text: ' ' },
      { text: 'c', code: true }, { text: ' ' },
      { text: 'site', link: 'https://example.com' },
    ],
  },
}];

describe('serializer — new marks round-trip (spine ⇄ PM)', () => {
  it('preserves all six marks + a link + overlapping marks through a full round-trip', () => {
    const doc = spineToPmDoc(deltoSchema, roundTripBody, 'Title');
    expect(pmDocToSpine(doc)).toEqual(roundTripBody);
  });

  it('renders each new mark to its schema mark (underline / strikethrough / highlight)', () => {
    const doc = spineToPmDoc(deltoSchema, roundTripBody, 'Title');
    const para = doc.child(1); // child(0) is the title node
    const tags = new Set<string>();
    para.forEach((child) => child.marks.forEach((m) => tags.add(m.type.name)));
    expect(tags).toContain('underline');
    expect(tags).toContain('strikethrough');
    expect(tags).toContain('highlight');
  });
});

describe('isTextSegment — guard accepts the new flags + stays forward-compatible', () => {
  it('accepts a segment with a new mark flag set to true', () => {
    expect(isTextSegment({ text: 'x', underline: true })).toBe(true);
    expect(isTextSegment({ text: 'x', strike: true })).toBe(true);
    expect(isTextSegment({ text: 'x', highlight: true })).toBe(true);
  });
  it('rejects a new flag with a non-true value', () => {
    expect(isTextSegment({ text: 'x', underline: 'yes' })).toBe(false);
    expect(isTextSegment({ text: 'x', strike: 1 })).toBe(false);
  });
  it('ignores unknown future flags rather than rejecting (forward-compat)', () => {
    expect(isTextSegment({ text: 'x', someFutureMark: true })).toBe(true);
  });
});

describe('clipboard — text/plain markdown export wraps every mark', () => {
  it('exports the all-marks line with deterministic wraps + a [text](url) link', () => {
    const doc = spineToPmDoc(deltoSchema, clipboardBody, 'Title');
    const para = doc.child(1);
    const out = sliceToPlainText(new Slice(Fragment.from(para), 0, 0));
    expect(out).toBe('plain **b** *i* ~~s~~ ==h== <u>u</u> `c` [site](https://example.com)');
  });
});
