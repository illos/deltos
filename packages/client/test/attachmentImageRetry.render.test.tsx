/**
 * Regression: the inline attachment image must NOT silently latch into a bare filename chip when the first
 * blob GET fails for want of a bearer. The editor is local-first — on a cold/offline open the NodeView
 * mounts BEFORE auth rehydrates, so the first `loadBlobUrl` can 401 (no bearer in memory yet). The fix keys
 * the load effect on the bearer token, so when the refresh mints it the load retries and the image appears
 * (the "dropped image stopped previewing" bug). loadBlobUrl is session-cached, so the retry is one fetch.
 *
 * jsdom has no layout engine, so this locks the DOM contract the CSS full-width fix rides on (the single
 * `img.attachment-image` element) + the no-latch retry behaviour — the pixel full-width was confirmed in a
 * real browser harness (real PM DOM + real attachment.css).
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';

const { loadBlobUrl } = vi.hoisted(() => ({ loadBlobUrl: vi.fn() }));
vi.mock('../src/plugins/attachment/blobClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/plugins/attachment/blobClient.js')>();
  return { ...actual, loadBlobUrl }; // keep the REAL isInlineRenderableImage gate
});

import { AttachmentView } from '../src/plugins/attachment/AttachmentNodeView.js';
import { useAuthStore } from '../src/auth/store.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); useAuthStore.setState({ bearerToken: null }); });

describe('attachment inline image — no-latch retry on bearer rehydrate', () => {
  beforeEach(() => { useAuthStore.setState({ bearerToken: null }); });

  it('first load fails (no bearer) → chip, no img; bearer arrives → retries → <img.attachment-image>', async () => {
    loadBlobUrl.mockRejectedValueOnce(new Error('blob load failed (401)')).mockResolvedValue('blob:ok');
    const payload = { hash: 'h', name: 'shot.png', mime: 'image/png', size: 10 };

    const { container } = render(<AttachmentView payload={payload} />);

    // Cold open with no bearer: the load is attempted and rejects → degrades to the chip, NOT an <img>.
    await waitFor(() => expect(loadBlobUrl).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('.attachment-chip')).not.toBeNull());
    expect(container.querySelector('img.attachment-image')).toBeNull();

    // The refresh mints the bearer → the effect re-runs and the image now resolves (no permanent latch).
    act(() => { useAuthStore.setState({ bearerToken: 'tok' }); });
    await waitFor(() => expect(container.querySelector('img.attachment-image')).not.toBeNull());
    expect(loadBlobUrl).toHaveBeenCalledTimes(2);
  });

  it('a healthy load (bearer present) renders the single inline img the full-width CSS targets', async () => {
    useAuthStore.setState({ bearerToken: 'tok' });
    loadBlobUrl.mockResolvedValue('blob:ok');

    const { container } = render(
      <AttachmentView payload={{ hash: 'h', name: 'p.webp', mime: 'image/webp', size: 10 }} />,
    );

    await waitFor(() => expect(container.querySelector('img.attachment-image')).not.toBeNull());
    expect(container.querySelectorAll('img.attachment-image')).toHaveLength(1);
    expect(loadBlobUrl).toHaveBeenCalledWith('h', 'image/webp');
  });
});
