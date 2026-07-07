/**
 * ShareExportPanel render test (ROAD-0011 P2 + ROAD-0017 / standing ui-features-need-rendered-ui-gate). Proves
 * the two former note-action surfaces (share-link + export) now live in ONE screen:
 *   - the combined panel renders the shell + "Share" header ONCE, then BOTH the "Share link" body (mint
 *     control) AND the "Export" body (Markdown / PDF / Print controls);
 *   - the panel is REACHABLE off the SINGLE ?share URL param (the lazy NoteRoute seam resolves under Suspense);
 *   - the desktop meta bar exposes ONE trigger (Share → ?share) — the old separate Export button is gone.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { Note } from '@deltos/shared';

// ── Shared module mocks (apply to the whole file) ────────────────────────────────────────────────
const { createShare, listShares, revokeShare } = vi.hoisted(() => ({
  createShare: vi.fn(),
  listShares: vi.fn(async () => []),
  revokeShare: vi.fn(),
}));
const { exportMarkdown, printNote } = vi.hoisted(() => ({
  exportMarkdown: vi.fn(async () => {}),
  printNote: vi.fn(async () => ({ ok: true })),
}));
const { saveShareUrl, getShareUrls, deleteShareUrl } = vi.hoisted(() => ({
  saveShareUrl: vi.fn(async () => {}),
  getShareUrls: vi.fn(async () => ({}) as Record<string, string>),
  deleteShareUrl: vi.fn(async () => {}),
}));

vi.mock('../lib/shareApi.js', () => {
  class ShareError extends Error {}
  return { createShare, listShares, revokeShare, ShareError };
});
vi.mock('../db/shareUrls.js', () => ({ saveShareUrl, getShareUrls, deleteShareUrl }));
vi.mock('../lib/exportNote.js', () => ({ exportMarkdown, printNote }));
vi.mock('../lib/toastEvents.js', () => ({ showToast: vi.fn(), showActionToast: vi.fn() }));
vi.mock('../lib/themeStore.js', () => ({
  useThemeStore: { getState: () => ({ palette: 'ember', voice: 'mono' }) },
}));

import { ShareExportPanel } from './ShareExportPanel.js';

const NOTE = { id: 'note-1', title: 'Test note', notebookId: null } as unknown as Note;

// ── The store hooks used by ShareLinkSection (useNotebooks) + NoteRoute (useNote) ────────────────
const routeState = vi.hoisted(() => ({ note: null as unknown }));
vi.mock('../db/storeHooks.js', () => ({ useNote: () => routeState.note, useNotebooks: () => [] }));

describe('ShareExportPanel', () => {
  // The combined panel reads accountId off the REAL auth store (selector form) — pin it via setState below.
  beforeEach(async () => {
    vi.clearAllMocks();
    listShares.mockResolvedValue([]);
    const { useAuthStore } = await import('../auth/store.js');
    useAuthStore.setState({ accountId: 'acct-1' });
  });
  afterEach(cleanup);

  it('renders the shell + "Share" header ONCE with BOTH the share-link and export bodies', async () => {
    render(<ShareExportPanel note={NOTE} onBack={() => {}} />);

    // Shell header renders once.
    expect(screen.getByRole('heading', { name: 'Share' })).not.toBeNull();
    // "Share link" body — the mint control.
    expect(await screen.findByLabelText('Create share link for “Test note”')).not.toBeNull();
    // "Export" body — the Markdown + Print controls.
    expect(screen.getByLabelText('Export as Markdown')).not.toBeNull();
    expect(screen.getByLabelText('Print')).not.toBeNull();
  });
});

// ── Reachability off the SINGLE ?share URL param (the lazy NoteRoute seam) ────────────────────────
vi.mock('../db/conflict.js', () => ({ useNoteVersions: () => [] }));
vi.mock('../lib/useIsDesktop.js', () => ({ useIsDesktop: () => true }));
vi.mock('../db/mutate.js', () => ({ mutateNotes: { put: vi.fn(), softDelete: vi.fn(), restore: vi.fn() } }));
vi.mock('../lib/syncEngine.js', () => ({ notifyQueueWrite: vi.fn() }));
vi.mock('../lib/historyCapture.js', () => ({ getHistoryCapture: () => ({ open: vi.fn(), leave: vi.fn(), recordEdit: vi.fn() }) }));
vi.mock('../db/store.js', () => ({ getStore: () => ({ discardBlankNote: vi.fn() }) }));
vi.mock('../lib/noteContent.js', () => ({ noteHasContent: () => true }));
vi.mock('./SyncIndicator.js', () => ({ SyncIndicator: () => <div /> }));
vi.mock('../editor/NoteEditor.js', () => ({ NoteEditor: () => <div /> }));
vi.mock('../editor/views.js', () => ({ resolveNoteView: () => () => <div data-testid="resolved-view" /> }));

import { NoteRoute } from '../routes/NoteRoute.js';
import { NoteMetaBar } from './NoteMetaBar.js';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('NoteRoute — ?share reachability (combined screen)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    listShares.mockResolvedValue([]);
    const { useAuthStore } = await import('../auth/store.js');
    useAuthStore.setState({ accountId: 'acct-1', bearerToken: 'tok' });
    routeState.note = { ...(NOTE as object), id: UUID, hasConflict: false, syncStatus: 'synced', version: 1 };
  });
  afterEach(cleanup);

  it('renders the combined Share screen (share-link + export) when ?share is set', async () => {
    render(
      <MemoryRouter initialEntries={[`/note/${UUID}?share`]}>
        <Routes>
          <Route path="/note/:id" element={<NoteRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    // The lazy chunk resolves under Suspense → the combined panel appears.
    expect(await screen.findByRole('heading', { name: 'Share' })).not.toBeNull();
    // BOTH bodies are present in the one screen.
    expect(await screen.findByLabelText('Create share link for “Test note”')).not.toBeNull();
    expect(screen.getByLabelText('Export as Markdown')).not.toBeNull();
    // The editor view is swapped out while the panel is up.
    expect(screen.queryByTestId('resolved-view')).toBeNull();
  });
});

// A tiny probe that surfaces the current location's search string for the trigger assertion.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.search}</div>;
}

describe('NoteMetaBar — single Share trigger', () => {
  afterEach(cleanup);

  it('exposes ONE Share button that opens ?share, and no separate Export button', () => {
    render(
      <MemoryRouter initialEntries={[`/note/${UUID}`]}>
        <Routes>
          <Route
            path="/note/:id"
            element={
              <>
                <NoteMetaBar
                  noteId={UUID as never}
                  isFull={false}
                  onShowHistory={() => {}}
                  onShowInfo={() => {}}
                  onDelete={() => {}}
                />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    // The merged single trigger — the old "Export note" button is gone.
    expect(screen.queryByLabelText('Export note')).toBeNull();
    const shareBtn = screen.getByLabelText('Share note');
    fireEvent.click(shareBtn);
    expect(screen.getByTestId('loc').textContent).toBe('?share');
  });
});
