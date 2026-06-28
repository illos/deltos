/**
 * PDF reader Slice 2 — thumbnail strip + jump-to-page mounted-UI gate (pdf-reader.md gate PDF-4 / PDF-UI;
 * ui-features-need-rendered-ui-gate). Mounts the REAL routed tree (NoteRoute → FileNoteView → lazy PdfReader)
 * with pdf.js mocked at the `pdfEngine` seam, and asserts the real DOM + the shared jump primitive wiring. The
 * live rasterize / feel is the deploy-time PDF-SMOKE.
 *
 *  S2-1  The thumbnail rail renders N thumbnails for an N-page doc (one interactive button per page), docked on
 *        desktop. The current page's thumb is marked active (aria-current).
 *  S2-2  Clicking a thumbnail jumps the main viewer to that page (renderPage called for it; current-page readout
 *        + active-thumb update) — the shared jump primitive.
 *  S2-3  Entering a page number in the toolbar control jumps to it; out-of-range input clamps to [1, total].
 *  S2-4  Thumbnails submit to the engine at LOW priority (RENDER_PRIORITY.THUMBNAIL) — they never starve the
 *        main viewer (one shared worker + queue).
 *  S2-5  Mobile: the rail is OFF by default (no width eaten) and opens as a drawer via the toolbar toggle.
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
const PAGES = 5;

const loadBlobBytes = vi.fn(async () => new ArrayBuffer(8));
const loadViewUrl = vi.fn(async () => 'blob:mock');
vi.mock('../src/plugins/attachment/blobClient.js', () => ({
  loadBlobBytes,
  loadViewUrl,
  downloadBlob: vi.fn(async () => {}),
  loadThumbUrl: vi.fn(async () => 'blob:mock'),
}));

// pdf.js engine seam mock — a fake N-page document. renderPage records (pageNumber, canvas, scale, opts) so the
// test can assert the visible page rasterized + the thumbnail priority. Re-exports RENDER_PRIORITY (the reader
// imports the constant from this module, so the mock must provide it).
const renderPage = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
const destroy = vi.fn(async () => {});
const makeDoc = () => ({
  numPages: PAGES,
  getPageDims: vi.fn(async () => ({ width: 600, height: 800 })),
  renderPage,
  getPageText: vi.fn(async () => ({ items: [] })),
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

// jsdom returns 0 for client box; the viewer + rail virtualization need real dimensions to mark pages/thumbs
// "live" and to compute jump offsets. Stub a fixed box on every element.
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

// useIsDesktop only queries `(min-width: 769px)`; return `desktop` for it so the test controls the device class.
function setDesktop(desktop: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: /min-width:\s*769px/.test(q) ? desktop : true,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
}

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  loadBlobBytes.mockReset().mockResolvedValue(new ArrayBuffer(8));
  renderPage.mockClear();
  openPdf.mockClear().mockResolvedValue(makeDoc());
  setDesktop(true);
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

const mainCalls = () => renderPage.mock.calls.filter((c) => (c[3]?.priority ?? 0) === 0);
const pageInput = () => screen.getByLabelText('Page number') as HTMLInputElement;

describe('PDF reader Slice 2 — thumbnail rail + jump-to-page', () => {
  it('S2-1 — renders N thumbnails for an N-page doc (docked desktop rail) with the current page active', async () => {
    await mountRoute();
    await waitFor(() => expect(document.querySelector('.pdf-reader__thumbs')).not.toBeNull());

    const thumbs = document.querySelectorAll('.pdf-reader__thumb');
    expect(thumbs.length).toBe(PAGES);
    // Page 1 is the active thumb on open.
    const active = document.querySelector('.pdf-reader__thumb--active');
    expect(active?.getAttribute('data-thumb')).toBe('1');
    expect(active?.getAttribute('aria-current')).toBe('page');
  });

  it('S2-2 — clicking a thumbnail jumps the viewer to that page (shared jump primitive)', async () => {
    await mountRoute();
    await waitFor(() => expect(document.querySelector('.pdf-reader__canvas')).not.toBeNull());
    await waitFor(() => expect(renderPage).toHaveBeenCalled());

    const thumb4 = document.querySelector('.pdf-reader__thumb[data-thumb="4"]') as HTMLButtonElement;
    fireEvent.click(thumb4);

    // The readout follows the jump and page 4 is rasterized in the MAIN viewer.
    await waitFor(() => expect(pageInput().value).toBe('4'));
    expect(mainCalls().some((c) => c[0] === 4)).toBe(true);
    expect(document.querySelector('.pdf-reader__thumb--active')?.getAttribute('data-thumb')).toBe('4');
  });

  it('S2-3 — the toolbar page field jumps to N and clamps out-of-range input', async () => {
    await mountRoute();
    await waitFor(() => expect(renderPage).toHaveBeenCalled());

    const input = pageInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(pageInput().value).toBe('3'));
    expect(mainCalls().some((c) => c[0] === 3)).toBe(true);

    // Out-of-range clamps to [1, total].
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(pageInput().value).toBe(String(PAGES)));
  });

  it('S2-4 — thumbnails submit to the shared queue at LOW priority (never starve the reader)', async () => {
    await mountRoute();
    await waitFor(() => expect(renderPage.mock.calls.some((c) => (c[3]?.priority ?? 0) === 1)).toBe(true));
    // The main viewer still renders its visible page at high (default) priority.
    expect(mainCalls().some((c) => c[0] === 1)).toBe(true);
  });

  it('S2-5 — mobile: rail is off by default and opens as a drawer via the toolbar toggle', async () => {
    setDesktop(false);
    await mountRoute();
    await waitFor(() => expect(document.querySelector('.pdf-reader')).not.toBeNull());

    // No rail eating width on open.
    expect(document.querySelector('.pdf-reader__thumbs')).toBeNull();

    fireEvent.click(screen.getByLabelText(/show page thumbnails/i));
    await waitFor(() => expect(document.querySelector('.pdf-reader__thumbs')).not.toBeNull());
    expect(document.querySelectorAll('.pdf-reader__thumb').length).toBe(PAGES);
    // A mobile drawer carries a backdrop to dismiss it.
    expect(document.querySelector('.pdf-reader__thumbs-backdrop')).not.toBeNull();
  });
});
