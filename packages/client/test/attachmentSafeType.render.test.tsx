/**
 * #132 A4-client HARD secSys gate (#694): the inline attachment preview object-URL-renders ONLY known-safe
 * raster images (png/jpeg/gif/webp). html / svg / anything else NEVER inline-renders (a blob: URL of html/
 * svg would re-introduce the XSS the server prevents) → a download chip, and the bytes are never even
 * loaded into an object URL.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

const { loadBlobUrl, downloadBlob } = vi.hoisted(() => ({
  loadBlobUrl: vi.fn(async () => 'blob:fake-url'),
  downloadBlob: vi.fn(async () => {}),
}));
vi.mock('../src/plugins/attachment/blobClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/plugins/attachment/blobClient.js')>();
  return { ...actual, loadBlobUrl, downloadBlob }; // keep the REAL isInlineRenderableImage gate
});

import { AttachmentView } from '../src/plugins/attachment/AttachmentNodeView.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('#132 attachment inline safe-type gate', () => {
  it('png → inline <img> via an object URL', async () => {
    const { container } = render(<AttachmentView payload={{ hash: 'h', name: 'p.png', mime: 'image/png', size: 10 }} />);
    await waitFor(() => expect(container.querySelector('img.attachment-image')).not.toBeNull());
    expect(loadBlobUrl).toHaveBeenCalledWith('h', 'image/png');
  });

  it('svg → NEVER inline; download chip; bytes never object-URL-loaded', () => {
    const { container } = render(<AttachmentView payload={{ hash: 'h', name: 'x.svg', mime: 'image/svg+xml', size: 10 }} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.attachment-download')).not.toBeNull();
    expect(loadBlobUrl).not.toHaveBeenCalled();
  });

  it('html → NEVER inline; download chip', () => {
    const { container } = render(<AttachmentView payload={{ hash: 'h', name: 'x.html', mime: 'text/html', size: 10 }} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.attachment-download')).not.toBeNull();
    expect(loadBlobUrl).not.toHaveBeenCalled();
  });
});
