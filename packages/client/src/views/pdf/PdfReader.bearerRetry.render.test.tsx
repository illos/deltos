/**
 * PdfReader bearer-retry on cold open (blob-cache feature, Part B). Mirrors the AttachmentNodeView fix for
 * the FIRST-ever open of a never-cached PDF during the pre-auth cold-boot window:
 *   - mount with bearerToken null → the blob GET 401s → loadBlobBytes rejects → phase 'error' (the latch);
 *   - the refresh mints a token (null→present) → the open RETRIES → the PDF loads;
 *   - GUARD: an already-`ready` doc does NOT re-parse on a later token rotation (PDF parse is expensive —
 *     the retry is scoped to the failed state via the `attempt`-counter dep, gated on phase==='error').
 *
 * loadBlobBytes + the pdf engine are mocked so the test drives the auth-window race deterministically with
 * no real network or pdf.js worker.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor, act } from '@testing-library/react';
import { useAuthStore } from '../../auth/store.js';

// loadBlobBytes: rejects while there is no bearer (simulating the 401), resolves once a bearer is present.
const loadBlobBytes = vi.fn();
vi.mock('../../plugins/attachment/blobClient.js', () => ({
  loadBlobBytes: (hash: string) => loadBlobBytes(hash),
}));

// A minimal OpenedPdf so the reader reaches phase 'ready' without a real pdf.js worker. openPdf is counted
// so we can assert "parsed exactly once".
const openPdf = vi.fn();
vi.mock('./pdfEngine.js', () => ({
  RENDER_PRIORITY: { THUMBNAIL: 0 },
  openPdf: (bytes: ArrayBuffer) => openPdf(bytes),
}));

async function importReader() {
  return (await import('./PdfReader.js')).PdfReader;
}

function fakeDoc() {
  return {
    numPages: 1,
    getPageDims: vi.fn(async () => ({ width: 100, height: 140 })),
    getPageText: vi.fn(async () => ({ items: [] })),
    renderPage: vi.fn(() => ({ promise: Promise.resolve(), cancel() {} })),
    destroy: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  loadBlobBytes.mockReset();
  openPdf.mockReset();
  useAuthStore.setState({ accountId: 'acctA', bearerToken: null });
});
afterEach(cleanup);

describe('PdfReader bearer-retry on cold open', () => {
  it('cold open with a null bearer errors, then retries + loads when the bearer arrives', async () => {
    // No bearer → the blob GET 401s; once a token is set, it resolves.
    loadBlobBytes.mockImplementation(async () => {
      if (!useAuthStore.getState().bearerToken) throw new Error('blob load failed (401)');
      return new Uint8Array([1, 2, 3]).buffer;
    });
    openPdf.mockImplementation(async () => fakeDoc());

    const PdfReader = await importReader();
    render(<PdfReader hash="h1" name="doc.pdf" onDownload={() => {}} />);

    // latched into the error/degrade state (the bug, pre-fix).
    await screen.findByText('Couldn’t open this PDF.');
    expect(openPdf).not.toHaveBeenCalled();

    // The refresh mints a token → null→present transition → retry.
    await act(async () => {
      useAuthStore.setState({ bearerToken: 'fresh' });
    });

    // The reader recovers: the error screen is gone and the PDF parsed exactly once on retry.
    await waitFor(() => {
      expect(screen.queryByText('Couldn’t open this PDF.')).toBeNull();
    });
    expect(openPdf).toHaveBeenCalledTimes(1);
    expect(loadBlobBytes).toHaveBeenCalledTimes(2); // first (failed) + retry (ok)
  });

  it('an already-ready doc does NOT re-parse on a later token rotation', async () => {
    // Bearer present from the start → first open succeeds.
    useAuthStore.setState({ bearerToken: 'tok' });
    loadBlobBytes.mockResolvedValue(new Uint8Array([9]).buffer);
    openPdf.mockImplementation(async () => fakeDoc());

    const PdfReader = await importReader();
    render(<PdfReader hash="h2" name="ready.pdf" onDownload={() => {}} />);

    await waitFor(() => expect(openPdf).toHaveBeenCalledTimes(1));

    // Rotate the access token (a normal mid-session re-mint). phase is 'ready', not 'error', so the retry
    // effect must NOT bump `attempt` → no re-open, no second expensive parse.
    await act(async () => {
      useAuthStore.setState({ bearerToken: 'rotated' });
    });
    await Promise.resolve();

    expect(openPdf).toHaveBeenCalledTimes(1);
    expect(loadBlobBytes).toHaveBeenCalledTimes(1);
  });
});
