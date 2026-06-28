/**
 * PDF reader Slice 1 — mounted-UI gate (pdf-reader.md gate PDF-UI; ui-features-need-rendered-ui-gate). Mounts
 * the REAL routed tree (NoteRoute → resolveNoteView → FileNoteView → second-level lazy PdfReader) and asserts
 * real DOM. pdf.js is mocked at the `pdfEngine` seam (the spellEngine-analogue), so no real PDF engine / Worker
 * is needed headlessly — the live rasterize is the deploy-time PDF-SMOKE.
 *
 *  PDF-UI-1  A pdf-type file note opens the PdfReader (toolbar + page count), NOT the "No preview" icon, and
 *            requests its bytes via loadBlobBytes(hash) (the authenticated blob GET — gate PDF-2).
 *  PDF-UI-2  The windowed viewer renders a live canvas for the visible page and calls engine.renderPage.
 *  PDF-UI-3  An IMAGE file note still shows the image preview (no regression).
 *  PDF-UI-4  A NORMAL note still opens the PM block editor (no regression).
 *  PDF-UI-5  A parse/offline failure degrades to the "Download to view" affordance (icon + Download chrome
 *            intact), never a broken/blank state (gate PDF-2 / §3.1).
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Note, NotebookId } from '@deltos/shared';
import { setFileType } from '@deltos/shared';
import { screen } from './renderHelpers.js';

const NB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const PDF_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1' as Note['id'];
const IMG_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2' as Note['id'];
const TXT_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3' as Note['id'];
const VIEW_URL = 'blob:mock-view-url';

// Blob client mock — loadBlobBytes feeds the reader the (mock) PDF bytes; loadViewUrl serves the image branch.
const loadBlobBytes = vi.fn(async () => new ArrayBuffer(8));
const loadViewUrl = vi.fn(async () => VIEW_URL);
vi.mock('../src/plugins/attachment/blobClient.js', () => ({
  loadBlobBytes,
  loadViewUrl,
  downloadBlob: vi.fn(async () => {}),
  loadThumbUrl: vi.fn(async () => VIEW_URL),
}));

// pdf.js engine seam mock — a fake 3-page document. renderPage is a spy returning a settled handle (no real
// rasterize); this is exactly the mock seam the PDF-UI gate prescribes.
const renderPage = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
const destroy = vi.fn(async () => {});
const openPdf = vi.fn(async () => ({
  numPages: 3,
  getPageDims: vi.fn(async () => ({ width: 600, height: 800 })),
  renderPage,
  getPageText: vi.fn(async () => ({ items: [] })),
  destroy,
}));
// RENDER_PRIORITY is imported by PdfReader (the thumbnail rail tags its low-priority renders with it), so the
// engine mock must re-export it.
vi.mock('../src/views/pdf/pdfEngine.js', () => ({ openPdf, RENDER_PRIORITY: { MAIN: 0, THUMBNAIL: 1, SEARCH: 2 } }));

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

function fileNote(id: Note['id'], filename: string, mime: string): Note {
  return makeNote({
    id,
    title: filename,
    properties: setFileType({}),
    body: [{ id: `${id}-b` as never, type: 'attachment', content: { hash: `${id}hash`, name: filename, mime, size: 4242 } }],
  });
}

async function mountRoute(id: Note['id'], note: Note) {
  const { db } = await import('../src/db/schema.js');
  await db.notes.put(note as Parameters<typeof db.notes.put>[0]);
  await import('../src/views/registerFileNoteView.js');
  const { NoteRoute } = await import('../src/routes/NoteRoute.js');
  return render(
    <MemoryRouter initialEntries={[`/note/${id}`]}>
      <Routes>
        <Route path="/note/:id" element={<NoteRoute />} />
        <Route path="/" element={<div>LIST VIEW</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// jsdom returns 0 for client dimensions; the viewer's fit-to-width math needs a real width to mark a page
// "live" and rasterize it. Stub a fixed viewport so PDF-UI-2 can assert a rendered canvas.
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
  loadViewUrl.mockReset().mockResolvedValue(VIEW_URL);
  renderPage.mockClear();
  openPdf.mockClear().mockResolvedValue({
    numPages: 3,
    getPageDims: vi.fn(async () => ({ width: 600, height: 800 })),
    renderPage,
    getPageText: vi.fn(async () => ({ items: [] })),
    destroy,
  });
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

describe('PDF reader Slice 1 — mounted viewer', () => {
  it('PDF-UI-1 — a pdf note opens the PdfReader (page count) and fetches bytes via loadBlobBytes', async () => {
    await mountRoute(PDF_ID, fileNote(PDF_ID, 'Q3-report.pdf', 'application/pdf'));

    await waitFor(() => expect(document.querySelector('.pdf-reader')).not.toBeNull());
    // It replaced the old "No preview" icon branch.
    expect(document.querySelector('.file-view__nopreview')).toBeNull();
    // Bytes come from the authenticated blob GET helper, keyed by hash.
    await waitFor(() => expect(loadBlobBytes).toHaveBeenCalledWith(`${PDF_ID}hash`, expect.anything()));
    expect(openPdf).toHaveBeenCalled();
    // Toolbar page control (Slice 2): an editable page field on the current page + a `/ total` readout.
    await waitFor(() => expect((screen.getByLabelText('Page number') as HTMLInputElement).value).toBe('1'));
    expect(screen.getByText('/ 3')).toBeTruthy();
  });

  it('PDF-UI-2 — the windowed viewer renders a live canvas for the visible page', async () => {
    await mountRoute(PDF_ID, fileNote(PDF_ID, 'doc.pdf', 'application/pdf'));

    await waitFor(() => expect(document.querySelector('.pdf-reader__canvas')).not.toBeNull());
    await waitFor(() => expect(renderPage).toHaveBeenCalled());
    // Page 1 (the visible page) is the one rasterized first.
    expect(renderPage.mock.calls[0]?.[0]).toBe(1);
  });

  it('PDF-UI-3 — an image file note still shows the image preview (no regression)', async () => {
    await mountRoute(IMG_ID, fileNote(IMG_ID, 'photo.png', 'image/png'));

    await waitFor(() => {
      const img = document.querySelector('.file-view__image') as HTMLImageElement | null;
      expect(img?.getAttribute('src')).toBe(VIEW_URL);
    });
    expect(document.querySelector('.pdf-reader')).toBeNull();
    expect(loadBlobBytes).not.toHaveBeenCalled();
  });

  it('PDF-UI-4 — a normal note still opens the PM block editor (no regression)', async () => {
    await mountRoute(TXT_ID, makeNote({ id: TXT_ID, title: 'Just prose', properties: {}, body: [] }));

    await waitFor(() => expect(document.querySelector('.editor__edited-line')).not.toBeNull());
    expect(document.querySelector('.pdf-reader')).toBeNull();
    expect(document.querySelector('.file-view')).toBeNull();
  });

  it('PDF-UI-5 — a parse/offline failure degrades to the Download-to-view affordance', async () => {
    openPdf.mockRejectedValueOnce(new Error('corrupt pdf'));
    await mountRoute(PDF_ID, fileNote(PDF_ID, 'broken.pdf', 'application/pdf'));

    await waitFor(() => expect(screen.getByText(/download to view/i)).toBeTruthy());
    expect(document.querySelector('.pdf-reader--error')).not.toBeNull();
    // No live canvas in the error state.
    expect(document.querySelector('.pdf-reader__canvas')).toBeNull();
  });

  it('PDF-UI-6 — a pdf.js parse failure surfaces the underlying cause as an on-screen diagnostic', async () => {
    // The reopen-detachment signature is exactly this shape: openPdf throws a detached-buffer error.
    openPdf.mockRejectedValueOnce(new Error('Cannot perform Construct on a detached ArrayBuffer'));
    await mountRoute(PDF_ID, fileNote(PDF_ID, 'reopen.pdf', 'application/pdf'));

    await waitFor(() => expect(screen.getByText(/download to view/i)).toBeTruthy());
    const detail = document.querySelector('.pdf-reader__error-detail');
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toMatch(/parse:.*detached ArrayBuffer/i);
  });

  it('PDF-UI-7 — a byte-fetch failure surfaces the HTTP status + bearer presence as a diagnostic', async () => {
    // A BlobLoadError-shaped rejection (status + bearer) — duck-typed by the reader (no class import needed).
    loadBlobBytes.mockReset().mockRejectedValueOnce(
      Object.assign(new Error('blob load failed (404)'), { status: 404, hadBearer: true, offline: false }),
    );
    await mountRoute(PDF_ID, fileNote(PDF_ID, 'missing.pdf', 'application/pdf'));

    await waitFor(() => expect(screen.getByText(/download to view/i)).toBeTruthy());
    const detail = document.querySelector('.pdf-reader__error-detail');
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toMatch(/fetch: HTTP 404, bearer/i);
  });
});
