import { describe, it, expect } from 'vitest';
import {
  setFileType,
  setExtract,
  buildAttachmentBlock,
  buildAttachmentContent,
  EXTRACT_TEXT_BUDGET,
  type Note,
  type NoteExtract,
  type PropertyBag,
} from '@deltos/shared';
import { searchNotes } from './search.js';

/**
 * ROAD-0014 client search over a file note's `sys:extract` (digital-PDF text / image OCR). Pins that a match
 * inside a file's extract (a) finds the note, (b) generates the snippet from the MATCHING page's text, and
 * (c) carries that page number on the result — while a normal note's behaviour is unchanged.
 */

let seq = 0;
function note(over: Partial<Note> & { properties?: PropertyBag } = {}): Note {
  seq += 1;
  return {
    id: `note-${seq}` as Note['id'],
    notebookId: null,
    title: '',
    properties: {},
    body: [],
    version: 1,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    syncStatus: 'synced',
    ...over,
  } as Note;
}

function fileNote(name: string, extract: NoteExtract): Note {
  const block = buildAttachmentBlock(
    buildAttachmentContent({ name, type: 'application/pdf' }, { hash: extract.blobHash, size: 100 }),
  );
  return note({ title: name, properties: setExtract(setFileType({}), extract), body: [block] as Note['body'] });
}

const pdfExtract = (pages: NoteExtract['pages'], over: Partial<NoteExtract> = {}): NoteExtract => ({
  v: 1, method: 'pdf-text', blobHash: 'h1', extractedAt: '2026-07-05T00:00:00.000Z', truncated: false, pages, ...over,
});

describe('searchNotes — file extract matches', () => {
  it('finds a match inside a PDF extract and reports the matching page + a snippet from that page', () => {
    const fn = fileNote('report.pdf', pdfExtract([
      { p: 1, t: 'the cover page introduces the company' },
      { p: 12, t: 'quarterly revenue reached a pineapple milestone this year' },
    ]));
    const [res] = searchNotes([fn], 'pineapple');
    expect(res).toBeDefined();
    expect(res!.note.id).toBe(fn.id);
    expect(res!.page).toBe(12); // mapped to the page the match lives on
    expect(res!.snippet.toLowerCase()).toContain('pineapple');
    // The highlight range covers the matched term within the snippet.
    expect(res!.snippetRanges.length).toBeGreaterThan(0);
  });

  it('an image OCR extract (page null) matches with NO page number', () => {
    const img = fileNote('receipt.png', {
      v: 1, method: 'ocr', blobHash: 'h2', extractedAt: '2026-07-05T00:00:00.000Z', truncated: false,
      pages: [{ p: null, t: 'total due 42 dollars invoice' }],
    });
    const [res] = searchNotes([img], 'invoice');
    expect(res!.page).toBeNull();
    expect(res!.snippet.toLowerCase()).toContain('invoice');
  });

  it('a title match on a file note still resolves (page falls back to body, null)', () => {
    const fn = fileNote('budget.pdf', pdfExtract([{ p: 1, t: 'unrelated body words' }]));
    const [res] = searchNotes([fn], 'budget');
    expect(res!.note.id).toBe(fn.id);
    expect(res!.page).toBeNull();
  });

  it('a normal note is unchanged: body match, page null', () => {
    const n = note({
      title: 'Groceries',
      body: [{ id: 'b1', type: 'paragraph', content: { segments: [{ text: 'buy avocados today' }] } }] as Note['body'],
    });
    const [res] = searchNotes([n], 'avocados');
    expect(res!.page).toBeNull();
    expect(res!.snippet).toContain('avocados');
  });

  it('multi-term: all terms must match somewhere across title/body/extract pages', () => {
    const fn = fileNote('doc.pdf', pdfExtract([
      { p: 3, t: 'the alpha section' },
      { p: 7, t: 'the omega section' },
    ]));
    // both terms present (different pages) → matches; snippet comes from the best-matching page.
    expect(searchNotes([fn], 'alpha omega')).toHaveLength(1);
    // a term absent everywhere → no match.
    expect(searchNotes([fn], 'alpha zzzznope')).toHaveLength(0);
  });
});

describe('searchNotes — perf guard over a max-size extract', () => {
  it('stays correct with a 32KB extract and returns the right page', () => {
    // Build a budget-sized multi-page extract; the needle lives on a known page.
    const filler = 'lorem ipsum dolor sit amet '.repeat(40); // ~1KB
    const pages = [];
    for (let p = 1; p <= 31; p++) pages.push({ p, t: filler });
    pages.push({ p: 32, t: `${filler} distinctivemarker end` });
    const totalLen = pages.reduce((n, pg) => n + pg.t.length, 0);
    expect(totalLen).toBeLessThanOrEqual(EXTRACT_TEXT_BUDGET + 2000); // representative of the capped size

    const fn = fileNote('big.pdf', pdfExtract(pages));
    const t0 = performance.now();
    const [res] = searchNotes([fn], 'distinctivemarker');
    const dt = performance.now() - t0;
    expect(res!.page).toBe(32);
    // Sanity ceiling — a single 32KB note must not take anywhere near this (informational, generous).
    expect(dt).toBeLessThan(500);
  });
});
