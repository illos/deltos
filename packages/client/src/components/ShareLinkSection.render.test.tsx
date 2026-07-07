/**
 * ShareLinkSection render test (ROAD-0011 P2 / standing ui-features-need-rendered-ui-gate). Mounts the REAL
 * "Share link" body (extracted from the old SharesPanel) over a mocked shareApi + a fake (in-memory)
 * client-local url store, and proves the user-visible contract:
 *   - it lists a resource's existing share links, each with a Revoke button;
 *   - "Create share link" → mint → NO separate reveal dialog: the new link drops straight into the list row
 *     with its URL + a working copy-to-clipboard, and is PERSISTED locally;
 *   - reopening re-hydrates the persisted url into the list row;
 *   - Revoke calls DELETE (revokeShare), optimistically drops the row, AND forgets the local url;
 *   - a share with NO local url (minted on another device) renders "link not saved on this device" + Re-mint.
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

// In-memory stand-in for the account-isolated Dexie url store (db/shareUrls.ts). Keyed `${accountId}::${shareId}`.
const { urlStore, saveShareUrl, getShareUrls, deleteShareUrl } = vi.hoisted(() => {
  const urlStore = new Map<string, string>();
  return {
    urlStore,
    saveShareUrl: vi.fn(async (accountId: string | null, shareId: string, url: string) => {
      if (accountId) urlStore.set(`${accountId}::${shareId}`, url);
    }),
    getShareUrls: vi.fn(async (accountId: string | null, ids: string[]) => {
      const out: Record<string, string> = {};
      if (accountId) for (const id of ids) {
        const u = urlStore.get(`${accountId}::${id}`);
        if (u) out[id] = u;
      }
      return out;
    }),
    deleteShareUrl: vi.fn(async (accountId: string | null, shareId: string) => {
      if (accountId) urlStore.delete(`${accountId}::${shareId}`);
    }),
  };
});

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
// The section reads the CURRENT theme off themeStore at mint to STAMP it onto the share (ROAD-0011 P2).
vi.mock('../lib/themeStore.js', () => ({
  useThemeStore: { getState: () => ({ palette: 'ember', voice: 'mono' }) },
}));
vi.mock('../db/shareUrls.js', () => ({ saveShareUrl, getShareUrls, deleteShareUrl }));
// The section reads the resident accountId off the auth store — pin it to a fixed account for the isolation scope.
vi.mock('../auth/store.js', () => ({
  useAuthStore: (sel: (s: { accountId: string | null }) => unknown) => sel({ accountId: 'acct-1' }),
}));

import { ShareLinkSection } from './ShareLinkSection.js';

const NOTE = { id: 'note-1', title: 'Test note', notebookId: null } as unknown as Note;
const URL_1 = 'https://deltos.blackgate.studio/s/tok_secret';

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
  urlStore.clear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});
afterEach(cleanup);

describe('ShareLinkSection', () => {
  it('mints a link (no reveal dialog), persists it, and surfaces it in the list row with Copy', async () => {
    // Empty on mount; after mint the refresh returns the new share so the list row appears.
    listShares.mockResolvedValueOnce([]).mockResolvedValue([share({ shareId: 's1' })]);
    createShare.mockResolvedValue({ shareId: 's1', token: 'tok_secret', url: URL_1 });

    const { getByLabelText, getByText, queryByLabelText, queryByText } = render(
      <ShareLinkSection note={NOTE} />,
    );

    await waitFor(() => expect(listShares).toHaveBeenCalledWith('note', 'note-1'));

    fireEvent.click(getByLabelText('Create share link for “Test note”'));

    // NO one-time reveal dialog — the new link drops straight into the list row (with its own url + Copy).
    const listField = (await waitFor(() =>
      getByLabelText('Share link created Jun 1, 2026'),
    )) as HTMLInputElement;
    expect(listField.value).toBe(URL_1);
    // The reveal-dialog affordances are gone (no shown-once field, no Done button).
    expect(queryByLabelText('Share link')).toBeNull();
    expect(queryByText('Done')).toBeNull();
    // The mint carries the owner's current theme stamp (palette+voice) from themeStore.
    expect(createShare).toHaveBeenCalledWith('note', 'note-1', { palette: 'ember', voice: 'mono' });
    // …and was persisted locally, account-scoped.
    expect(saveShareUrl).toHaveBeenCalledWith('acct-1', 's1', URL_1);

    // The row's own Copy button writes the URL + toasts + flashes "Copied!".
    fireEvent.click(getByLabelText('Copy share link created Jun 1, 2026'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(URL_1));
    await waitFor(() => expect(getByText('Copied!')).toBeTruthy());
    expect(showToast).toHaveBeenCalledWith('Share link copied');
  });

  it('re-hydrates a persisted URL into the list row on (re)open', async () => {
    urlStore.set('acct-1::s1', URL_1); // as if minted earlier on this device
    listShares.mockResolvedValue([share({ shareId: 's1' })]);

    const { getByLabelText } = render(<ShareLinkSection note={NOTE} />);

    const listField = (await waitFor(() =>
      getByLabelText('Share link created Jun 1, 2026'),
    )) as HTMLInputElement;
    expect(listField.value).toBe(URL_1);
    expect(getShareUrls).toHaveBeenCalledWith('acct-1', ['s1']);
  });

  it('shows a Re-mint affordance for a link with no local URL', async () => {
    // No urlStore entry for s1 → minted on another device.
    listShares.mockResolvedValue([share({ shareId: 's1' })]);

    const { getByText, getByLabelText, queryByLabelText } = render(
      <ShareLinkSection note={NOTE} />,
    );

    await waitFor(() => expect(getByText('link not saved on this device')).toBeTruthy());
    // No copyable url field for this row.
    expect(queryByLabelText('Share link created Jun 1, 2026')).toBeNull();
    // Re-mint mints a fresh link and persists it.
    createShare.mockResolvedValue({ shareId: 's2', token: 'tok2', url: 'https://x/s/tok2' });
    fireEvent.click(getByLabelText('Re-mint share link'));
    await waitFor(() => expect(createShare).toHaveBeenCalledWith('note', 'note-1', { palette: 'ember', voice: 'mono' }));
    await waitFor(() => expect(saveShareUrl).toHaveBeenCalledWith('acct-1', 's2', 'https://x/s/tok2'));
  });

  it('lists an existing link and Revoke drops the row, calls DELETE, and forgets the local URL', async () => {
    urlStore.set('acct-1::s1', URL_1);
    listShares.mockResolvedValueOnce([share({ shareId: 's1' })]).mockResolvedValueOnce([]);
    revokeShare.mockResolvedValue(undefined);

    const { getByLabelText, queryByLabelText } = render(
      <ShareLinkSection note={NOTE} />,
    );

    const revokeBtn = await waitFor(() => getByLabelText(/^Revoke share link/));
    expect(revokeBtn).toBeTruthy();

    fireEvent.click(revokeBtn);

    await waitFor(() => expect(revokeShare).toHaveBeenCalledWith('s1'));
    expect(deleteShareUrl).toHaveBeenCalledWith('acct-1', 's1');
    // Optimistic drop → the row (and its Revoke button) is gone.
    await waitFor(() => expect(queryByLabelText(/^Revoke share link/)).toBeNull());
  });
});
