import { describe, it, expect } from 'vitest';
import {
  SYS_EXTRACT_KEY,
  EXTRACT_TEXT_BUDGET,
  getExtract,
  setExtract,
  extractFlatText,
  extractPropsText,
  packExtractPages,
  needsExtraction,
  extractionTarget,
  attachmentContent,
  extractionKind,
  setFileType,
  buildAttachmentBlock,
  buildAttachmentContent,
  isReservedKey,
  userProperties,
  type NoteExtract,
  type PropertyBag,
} from '../src/index.js';

const extract = (over: Partial<NoteExtract> = {}): NoteExtract => ({
  v: 1,
  method: 'pdf-text',
  blobHash: 'abc123',
  extractedAt: '2026-07-05T00:00:00.000Z',
  truncated: false,
  pages: [{ p: 1, t: 'hello world' }],
  ...over,
});

const fileNote = (hash: string, mime: string, name = 'doc.pdf') => {
  const block = buildAttachmentBlock(buildAttachmentContent({ name, type: mime }, { hash, size: 100 }));
  return { properties: setFileType({}) as PropertyBag, body: [block] };
};

describe('extract — sys:extract property', () => {
  it('is a reserved system key (hidden + export-stripped for free)', () => {
    expect(SYS_EXTRACT_KEY).toBe('sys:extract');
    expect(isReservedKey(SYS_EXTRACT_KEY)).toBe(true);
    const bag = setExtract({}, extract());
    expect(userProperties(bag)).toEqual({}); // stripped from user-facing surfaces
  });

  it('round-trips through set/getExtract as a text-typed JSON value', () => {
    const bag = setExtract({}, extract());
    expect(bag[SYS_EXTRACT_KEY]!.type).toBe('text'); // fits PropertyBag validation
    expect(getExtract(bag)).toEqual(extract());
  });

  it('getExtract is FAIL-SAFE on absent / non-text / bad-JSON / bad-schema', () => {
    expect(getExtract({})).toBeNull();
    expect(getExtract({ [SYS_EXTRACT_KEY]: { type: 'number', value: 1 } })).toBeNull();
    expect(getExtract({ [SYS_EXTRACT_KEY]: { type: 'text', value: 'not json' } })).toBeNull();
    expect(getExtract({ [SYS_EXTRACT_KEY]: { type: 'text', value: '{"v":2}' } })).toBeNull();
  });

  it('extractFlatText / extractPropsText join non-empty pages', () => {
    const ex = extract({ pages: [{ p: 1, t: 'alpha' }, { p: 2, t: '' }, { p: 3, t: 'beta' }] });
    expect(extractFlatText(ex)).toBe('alpha beta');
    expect(extractPropsText(JSON.stringify(setExtract({}, ex)))).toBe('alpha beta');
    expect(extractPropsText('not json')).toBe('');
    expect(extractPropsText(null)).toBe('');
  });
});

describe('packExtractPages — budget truncation at page boundaries', () => {
  it('keeps whole pages under budget, not truncated', () => {
    const { pages, truncated } = packExtractPages([{ p: 1, t: 'ab' }, { p: 2, t: 'cd' }], 10);
    expect(pages).toEqual([{ p: 1, t: 'ab' }, { p: 2, t: 'cd' }]);
    expect(truncated).toBe(false);
  });

  it('clips the overflowing page + drops the rest, sets truncated', () => {
    const { pages, truncated } = packExtractPages([{ p: 1, t: 'aaaa' }, { p: 2, t: 'bbbb' }, { p: 3, t: 'cccc' }], 6);
    // page 1 full (4), page 2 clipped to remaining 2, page 3 dropped
    expect(pages).toEqual([{ p: 1, t: 'aaaa' }, { p: 2, t: 'bb' }]);
    expect(truncated).toBe(true);
  });

  it('a single over-budget page is clipped to the budget', () => {
    const { pages, truncated } = packExtractPages([{ p: 1, t: 'x'.repeat(100) }], 10);
    expect(pages).toEqual([{ p: 1, t: 'x'.repeat(10) }]);
    expect(truncated).toBe(true);
  });

  it('default budget is EXTRACT_TEXT_BUDGET (32KB)', () => {
    expect(EXTRACT_TEXT_BUDGET).toBe(32 * 1024);
    const { pages, truncated } = packExtractPages([{ p: 1, t: 'y'.repeat(EXTRACT_TEXT_BUDGET + 5) }]);
    expect(pages[0]!.t.length).toBe(EXTRACT_TEXT_BUDGET);
    expect(truncated).toBe(true);
  });
});

describe('extraction eligibility predicate', () => {
  it('extractionKind classifies pdf / image / neither', () => {
    expect(extractionKind('application/pdf')).toBe('pdf');
    expect(extractionKind('image/png')).toBe('image');
    expect(extractionKind('image/heic')).toBe('image');
    expect(extractionKind('text/plain')).toBeNull();
    expect(extractionKind('model/gltf-binary')).toBeNull();
  });

  it('extractionTarget: null for non-file notes, the attachment for extractable file notes', () => {
    // A normal note (no fileType marker) is never a target.
    expect(extractionTarget({ properties: {}, body: [] })).toBeNull();
    const pdf = fileNote('h1', 'application/pdf');
    expect(extractionTarget(pdf)).toEqual({
      attachment: { hash: 'h1', name: 'doc.pdf', mime: 'application/pdf', size: 100 },
      kind: 'pdf',
    });
    // A non-extractable file note (e.g. .blend) → null (never extracted, never retried).
    expect(extractionTarget(fileNote('h2', 'application/octet-stream', 'x.blend'))).toBeNull();
  });

  it('needsExtraction: true when missing, false once the blobHash matches, true again on hash change', () => {
    const note = fileNote('h1', 'application/pdf');
    expect(needsExtraction(note)).toBe(true);

    const done = { ...note, properties: setExtract(note.properties, extract({ blobHash: 'h1' })) };
    expect(needsExtraction(done)).toBe(false);

    // Same note body (hash h1) but a stale extract for a different hash → needs re-extraction.
    const stale = { ...note, properties: setExtract(note.properties, extract({ blobHash: 'OLD' })) };
    expect(needsExtraction(stale)).toBe(true);
  });

  it('attachmentContent is FAIL-SAFE on a non-attachment body', () => {
    expect(attachmentContent([])).toBeNull();
    expect(attachmentContent([{ id: 'b', type: 'paragraph', content: {} } as never])).toBeNull();
  });
});
