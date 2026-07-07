/**
 * SharesPanel render test (ROAD-0011 P2 / standing ui-features-need-rendered-ui-gate). Mounts the REAL
 * panel over a mocked shareApi and proves the user-visible contract:
 *   - it lists a resource's existing share links, each with a Revoke button;
 *   - "Create share link" → mint → the returned URL is shown ONCE with a working copy-to-clipboard;
 *   - Revoke calls DELETE (revokeShare) with the shareId and optimistically drops the row.
 *
 * Uses a note with notebookId=null so ONLY the note share-target renders (no notebook target), keeping
 * the button/row assertions unambiguous.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Note } from '@deltos/shared';

const { createShare, listShares, revokeShare, showToast } = vi.hoisted(() => ({
  createShare: vi.fn(),
  listShares: vi.fn(),
  revokeShare: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../lib/shareApi.js', () => {
  class ShareError extends Error {
    status?: number | undefined;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'ShareError';
      this.status = status;
    }
  }
  return { createShare, listShares, revokeShare, ShareError };
});
vi.mock('../lib/toastEvents.js', () => ({ showToast }));
vi.mock('../db/storeHooks.js', () => ({ useNotebooks: () => [] }));

import { SharesPanel } from './SharesPanel.js';

const NOTE = { id: 'note-1', title: 'Test note', notebookId: null } as unknown as Note;

function share(over: Partial<{ shareId: string; createdAt: string }> = {}) {
  return {
    shareId: over.shareId ?? 's1',
    resourceType: 'note' as const,
    resourceId: 'note-1',
    createdAt: over.createdAt ?? '2026-06-01T00:00:00.000Z',
    revoked: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});
afterEach(cleanup);

describe('SharesPanel', () => {
  it('mints a link, shows the URL once, and copies it', async () => {
    listShares.mockResolvedValue([]);
    createShare.mockResolvedValue({
      shareId: 's1',
      token: 'tok_secret',
      url: 'https://deltos.blackgate.studio/s/tok_secret',
    });

    const { getByLabelText, getByText } = render(<SharesPanel note={NOTE} onBack={() => {}} />);

    // The note share-target loaded its (empty) list on mount.
    await waitFor(() => expect(listShares).toHaveBeenCalledWith('note', 'note-1'));

    fireEvent.click(getByLabelText('Create share link for “Test note”'));

    // The minted URL is surfaced once, in a selectable field.
    const field = (await waitFor(() => getByLabelText('Share link'))) as HTMLTextAreaElement;
    expect(field.value).toBe('https://deltos.blackgate.studio/s/tok_secret');
    expect(createShare).toHaveBeenCalledWith('note', 'note-1');

    // Copy writes the URL to the clipboard and confirms.
    fireEvent.click(getByLabelText('Copy share link'));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://deltos.blackgate.studio/s/tok_secret',
      ),
    );
    await waitFor(() => expect(getByText('Copied!')).toBeTruthy());
    expect(showToast).toHaveBeenCalledWith('Share link copied');
  });

  it('lists an existing link and Revoke drops the row + calls DELETE', async () => {
    listShares.mockResolvedValueOnce([share({ shareId: 's1' })]).mockResolvedValueOnce([]);
    revokeShare.mockResolvedValue(undefined);

    const { getByLabelText, queryByLabelText } = render(
      <SharesPanel note={NOTE} onBack={() => {}} />,
    );

    // The existing link row renders with a Revoke button (getByLabelText throws until it appears, so
    // waitFor retries past the async list load).
    const revokeBtn = await waitFor(() => getByLabelText(/^Revoke share link/));
    expect(revokeBtn).toBeTruthy();

    fireEvent.click(revokeBtn);

    await waitFor(() => expect(revokeShare).toHaveBeenCalledWith('s1'));
    // Optimistic drop → the row (and its Revoke button) is gone.
    await waitFor(() => expect(queryByLabelText(/^Revoke share link/)).toBeNull());
  });
});
