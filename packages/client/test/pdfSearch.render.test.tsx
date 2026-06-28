/**
 * PDF reader Slice 3 — in-PDF text search, mounted-UI + SECURITY gate (pdf-reader.md gates PDF-5 / PDF-6 /
 * PDF-S / PDF-UI; ui-features-need-rendered-ui-gate). Mounts the REAL routed tree (NoteRoute → FileNoteView →
 * lazy PdfReader) with pdf.js mocked at the `pdfEngine` seam — getPageText returns KNOWN text per page (incl. an
 * XSS payload). The live rasterize/extraction is the deploy-time PDF-SMOKE.
 *
 *  S3-1  Typing a query finds N matches across pages and shows an accurate "x of N" counter (gate PDF-5).
 *  S3-2  Next/prev walk the matches and update "x of N"; navigating to a match on another page jumps the viewer
 *        to that page via the shared jump primitive (the page readout follows) (gate PDF-5).
 *  S3-3  The inert text layer renders for the visible page → a search match paints a highlight, the active match
 *        distinctly (gate PDF-6 / §5.3).
 *  S3-SEC  🔒 Extracted PDF text is rendered as TEXT, never markup: a run containing `<img src=x onerror=…>` /
 *        `</span>` appears as literal text (no <img> element is created, no script runs), and the search
 *        highlight does not interpret the matched text as HTML either (gate PDF-S).
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Note, NotebookId } from '@deltos/shared';
import { setFileType } from '@deltos/shared';
import { screen } from './renderHelpers.js';

const NB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const PDF_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1' as Note['id'];
const PAGES = 3;

// The XSS payload an attacker could embed as PDF text — it must reach the DOM only as literal text.
const EVIL = '<img src=x onerror=alert(1)></span>';

// Per-page extracted text (mock getTextContent). "the" appears: p1×1, p2×2, p3×1 → 4 total.
const PAGE_STRINGS: Record<number, string[]> = {
  1: ['the cat ', `${EVIL} img`],
  2: ['the the'],
  3: ['the dog'],
};
function toItem(str: string) {
  return { str, left: 0, top: 0, width: str.length * 5, height: 10 };
}

const loadBlobBytes = vi.fn(async () => new ArrayBuffer(8));
vi.mock('../src/plugins/attachment/blobClient.js', () => ({
  loadBlobBytes,
  loadViewUrl: vi.fn(async () => 'blob:mock'),
  downloadBlob: vi.fn(async () => {}),
  loadThumbUrl: vi.fn(async () => 'blob:mock'),
}));

const renderPage = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
const getPageText = vi.fn(async (n: number) => ({ items: (PAGE_STRINGS[n] ?? []).map(toItem) }));
const destroy = vi.fn(async () => {});
const makeDoc = () => ({
  numPages: PAGES,
  getPageDims: vi.fn(async () => ({ width: 600, height: 800 })),
  renderPage,
  getPageText,
  destroy,
});
const openPdf = vi.fn(async () => makeDoc());
vi.mock('../src/views/pdf/pdfEngine.js', () => ({
  openPdf,
  RENDER_PRIORITY: { MAIN: 0, THUMBNAIL: 1, SEARCH: 2 },
}));

function makeNote(over: Partial<Note>): Note {
  return {
    id: PDF_ID,
    notebookId: NB,
    title: 'file',
    properties: {},
    body: [],
    version: 1,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    syncStatus: 'synced',
    ...over,
  };
}
function pdfNote(): Note {
  return makeNote({
    id: PDF_ID,
    title: 'report.pdf',
    properties: setFileType({}),
    body: [
      {
        id: `${PDF_ID}-b` as never,
        type: 'attachment',
        content: { hash: `${PDF_ID}hash`, name: 'report.pdf', mime: 'application/pdf', size: 4242 },
      },
    ],
  });
}

async function mountRoute() {
  const { db } = await import('../src/db/schema.js');
  await db.notes.put(pdfNote() as Parameters<typeof db.notes.put>[0]);
  await import('../src/views/registerFileNoteView.js');
  const { NoteRoute } = await import('../src/routes/NoteRoute.js');
  return render(
    <MemoryRouter initialEntries={[`/note/${PDF_ID}`]}>
      <Routes>
        <Route path="/note/:id" element={<NoteRoute />} />
        <Route path="/" element={<div>LIST VIEW</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

let dimSpies: Array<() => void> = [];
function stubClientBox(width: number, height: number) {
  for (const [prop, val] of [['clientWidth', width], ['clientHeight', height]] as const) {
    const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => val });
    dimSpies.push(() => {
      if (orig) Object.defineProperty(HTMLElement.prototype, prop, orig);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    });
  }
}

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  loadBlobBytes.mockReset().mockResolvedValue(new ArrayBuffer(8));
  renderPage.mockClear();
  getPageText.mockClear();
  openPdf.mockClear().mockResolvedValue(makeDoc());
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
  stubClientBox(600, 800);
});

afterEach(() => {
  cleanup();
  dimSpies.forEach((r) => r());
  dimSpies = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const openSearch = () => fireEvent.click(screen.getByLabelText('Search'));
const searchInput = () => screen.getByLabelText('Search in document') as HTMLInputElement;
const counter = () => document.querySelector('.pdf-reader__search-count')?.textContent ?? '';
const pageInput = () => screen.getByLabelText('Page number') as HTMLInputElement;

describe('PDF reader Slice 3 — in-PDF text search', () => {
  it('S3-1 — typing a query finds N matches across pages with an accurate "x of N" counter', async () => {
    await mountRoute();
    await waitFor(() => expect(document.querySelector('.pdf-reader')).not.toBeNull());

    openSearch();
    fireEvent.change(searchInput(), { target: { value: 'the' } });

    // 4 occurrences of "the" across the 3 pages; auto-selects the first → "1 of 4".
    await waitFor(() => expect(counter()).toBe('1 of 4'));
  });

  it('S3-2 — next/prev walk matches, update the counter, and jump the viewer to the match’s page', async () => {
    await mountRoute();
    await waitFor(() => expect(document.querySelector('.pdf-reader')).not.toBeNull());

    openSearch();
    fireEvent.change(searchInput(), { target: { value: 'the' } });
    await waitFor(() => expect(counter()).toBe('1 of 4'));

    // Walk forward to the last match (on page 3) — the readout follows via the shared jump primitive.
    fireEvent.click(screen.getByLabelText('Next match'));
    await waitFor(() => expect(counter()).toBe('2 of 4'));
    fireEvent.click(screen.getByLabelText('Next match'));
    await waitFor(() => expect(counter()).toBe('3 of 4'));
    fireEvent.click(screen.getByLabelText('Next match'));
    await waitFor(() => expect(counter()).toBe('4 of 4'));
    // The 4th match lives on page 3 → the jump primitive moved the viewer there (page readout = 3) and the page
    // rasterized in the MAIN viewer.
    await waitFor(() => expect(pageInput().value).toBe('3'));
    expect(renderPage.mock.calls.some((c) => c[0] === 3 && (c[3]?.priority ?? 0) === 0)).toBe(true);

    // Prev steps back and updates the counter.
    fireEvent.click(screen.getByLabelText('Previous match'));
    await waitFor(() => expect(counter()).toBe('3 of 4'));
  });

  it('S3-3 — the inert text layer paints match highlights, with the active match styled distinctly', async () => {
    await mountRoute();
    await waitFor(() => expect(document.querySelector('.pdf-reader__textlayer')).not.toBeNull());

    openSearch();
    fireEvent.change(searchInput(), { target: { value: 'the' } });

    await waitFor(() => expect(document.querySelectorAll('.pdf-reader__hl').length).toBeGreaterThan(0));
    // Exactly one ACTIVE highlight (the current match).
    await waitFor(() => expect(document.querySelectorAll('.pdf-reader__hl--active').length).toBe(1));
    expect(document.querySelector('.pdf-reader__hl--active')?.textContent).toBe('the');
  });

  it('S3-SEC — extracted PDF text renders as TEXT, never markup (no HTML injection)', async () => {
    await mountRoute();
    // The text layer for the (visible) first page renders the attacker run.
    await waitFor(() => expect(document.querySelector('.pdf-reader__textlayer')).not.toBeNull());
    await waitFor(() =>
      expect(document.querySelector('.pdf-reader__textlayer')?.textContent ?? '').toContain(EVIL),
    );

    // The dangerous markup created NO element and NO attribute parse: there is no <img>, no orphan element.
    expect(document.querySelectorAll('img').length).toBe(0);
    expect(document.querySelector('img[src="x"]')).toBeNull();

    // Now drive a search that matches INSIDE the attacker run ("img") — the highlight path must also stay inert.
    openSearch();
    fireEvent.change(searchInput(), { target: { value: 'img' } });
    await waitFor(() => expect(document.querySelectorAll('.pdf-reader__hl').length).toBeGreaterThan(0));
    // Still no real <img> element, and the literal payload text is intact in the layer.
    expect(document.querySelectorAll('img').length).toBe(0);
    expect(document.querySelector('.pdf-reader__textlayer')?.textContent ?? '').toContain(EVIL);
    // The highlighted match is the literal substring "img" (a text node), not a parsed element.
    expect(
      Array.from(document.querySelectorAll('.pdf-reader__hl')).some((el) => el.textContent === 'img'),
    ).toBe(true);
  });
});
